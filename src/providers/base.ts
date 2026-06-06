/**
 * Shared OpenAI-compatible provider. Most local servers (Ollama, LM Studio,
 * vLLM, llama.cpp) expose an OpenAI-style /v1/chat/completions endpoint, so we
 * implement once here and let concrete providers tweak URLs / health checks.
 */
import type {
  GenerateResult,
  Message,
  ModelInfo,
  ModelOptions,
  Provider,
  ToolCall,
} from "../types";

export interface ProviderConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  contextTokens?: number;
  gpuLayers?: number;
  lowVram?: boolean;
  keepAlive?: string;
}

export abstract class OpenAICompatibleProvider implements Provider {
  abstract readonly name: string;

  constructor(protected cfg: ProviderConfig) {}

  get model(): string {
    return this.cfg.model;
  }

  /** Switch the active model for subsequent requests. */
  setModel(model: string): void {
    this.cfg.model = model;
  }

  /** List models via the OpenAI-style /models endpoint. */
  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.apiBase()}/models`, { headers: this.headers() });
    if (!res.ok) throw new Error(`${this.name} HTTP ${res.status}`);
    const json: any = await res.json();
    const data: any[] = json?.data ?? json?.models ?? [];
    return data.map((m) => ({ name: m.id ?? m.name })).filter((m) => m.name);
  }

  /** OpenAI-style base; concrete providers append /v1 when needed. */
  protected apiBase(): string {
    const b = this.cfg.baseUrl.replace(/\/+$/, "");
    return b.endsWith("/v1") ? b : b + "/v1";
  }

  protected headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.apiKey) h["Authorization"] = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  /**
   * Whether this backend/model honors the `system` role. Some hosted models
   * (e.g. Kimi K2.x on NVIDIA NIM) degenerate into repetition when given a
   * system message, so subclasses can opt to fold it into the user turn.
   */
  protected systemRoleSupported(): boolean {
    return true;
  }

  /** Map our internal Message[] to OpenAI wire format (incl. tool fields). */
  protected wireMessages(messages: Message[]): Record<string, unknown>[] {
    let prepared = mergeSystem(messages);
    if (!this.systemRoleSupported()) prepared = foldSystemIntoUser(prepared);
    return prepared.map((m) => {
      if (m.role === "tool") {
        return { role: "tool", content: m.content, tool_call_id: m.tool_call_id, name: m.name };
      }
      if (m.role === "assistant" && m.tool_calls?.length) {
        return {
          role: "assistant",
          content: m.content || "",
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  protected body(messages: Message[], options: ModelOptions, stream: boolean) {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: this.wireMessages(messages),
      temperature: options.temperature ?? this.cfg.temperature,
      top_p: options.top_p ?? this.cfg.topP,
      max_tokens: options.max_tokens ?? this.cfg.maxTokens,
      stream,
    };
    if (options.stop) body.stop = options.stop;
    if (options.json) body.response_format = { type: "json_object" };
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    return body;
  }

  async generate(
    messages: Message[],
    options: ModelOptions = {}
  ): Promise<GenerateResult> {
    const res = await fetch(`${this.apiBase()}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.body(messages, options, false)),
    });
    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`${this.name} HTTP ${res.status}: ${detail}`);
    }
    const json: any = await res.json();
    const msg: any = json?.choices?.[0]?.message ?? {};
    const text: string = msg?.content ?? "";
    const toolCalls = parseToolCalls(msg?.tool_calls);
    return {
      text,
      toolCalls,
      model: this.cfg.model,
      promptTokens: json?.usage?.prompt_tokens,
      completionTokens: json?.usage?.completion_tokens,
    };
  }

  async stream(
    messages: Message[],
    onChunk: (delta: string) => void,
    options: ModelOptions = {}
  ): Promise<GenerateResult> {
    const res = await fetch(`${this.apiBase()}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.body(messages, options, true)),
    });
    if (!res.ok || !res.body) {
      const detail = await safeText(res);
      throw new Error(`${this.name} HTTP ${res.status}: ${detail}`);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    // Node 18+ fetch body is an async-iterable web stream.
    for await (const chunk of res.body as any) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          const delta: string = obj?.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            full += delta;
            onChunk(delta);
          }
        } catch {
          /* ignore keep-alive / partial frames */
        }
      }
    }
    return { text: full, model: this.cfg.model };
  }

  /** Rough heuristic: ~4 chars per token. Good enough for budgeting. */
  countTokens(text: string): number {
    return Math.ceil((text || "").length / 4);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(`${this.apiBase()}/models`, {
        headers: this.headers(),
      });
      return { ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}

/**
 * Collapse multiple `system` messages into one (at the first system's position).
 * Some model chat templates (e.g. LM Studio's qwen3.5) error with "No user query
 * found" when given more than one system message.
 */
function mergeSystem(messages: Message[]): Message[] {
  if (messages.filter((m) => m.role === "system").length <= 1) return messages;
  const merged = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const out: Message[] = [];
  let placed = false;
  for (const m of messages) {
    if (m.role === "system") {
      if (!placed) {
        out.push({ role: "system", content: merged });
        placed = true;
      }
    } else {
      out.push(m);
    }
  }
  return out;
}

/**
 * Demote a leading `system` message into the conversation as user content, for
 * backends/models that mishandle the system role. Assumes mergeSystem already
 * collapsed system messages to at most one. The system text is prepended to the
 * first user message (or inserted as a standalone user message if there is none),
 * so the model still receives the instructions without a `system` role.
 */
function foldSystemIntoUser(messages: Message[]): Message[] {
  const sys = messages.find((m) => m.role === "system");
  if (!sys) return messages;
  const rest = messages.filter((m) => m.role !== "system");
  const firstUserIdx = rest.findIndex((m) => m.role === "user");
  if (firstUserIdx === -1) {
    return [{ role: "user", content: sys.content }, ...rest];
  }
  const out = rest.slice();
  out[firstUserIdx] = {
    ...out[firstUserIdx],
    content: `${sys.content}\n\n---\n\n${out[firstUserIdx].content}`,
  };
  return out;
}

/** Normalize OpenAI-style tool_calls into our ToolCall[]. */
function parseToolCalls(raw: any): ToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const calls: ToolCall[] = [];
  for (let i = 0; i < raw.length; i++) {
    const fn = raw[i]?.function;
    if (!fn?.name) continue;
    let args: Record<string, any> = {};
    try {
      args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments || "{}") : fn.arguments ?? {};
    } catch {
      args = { _raw: fn.arguments };
    }
    calls.push({ id: raw[i].id || `call_${i}`, name: fn.name, arguments: args });
  }
  return calls.length ? calls : undefined;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}
