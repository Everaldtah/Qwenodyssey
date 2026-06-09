import { OpenAICompatibleProvider } from "./base";
import type { GenerateResult, Message, ModelOptions, ModelInfo, ToolCall } from "../types";

/** Ollama serves an OpenAI-compatible API at {base}/v1 and native at {base}/api. */
export class OllamaProvider extends OpenAICompatibleProvider {
  readonly name = "ollama";

  private root(): string {
    return this.cfg.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  }

  /**
   * Generate via Ollama's NATIVE /api/chat instead of the OpenAI-compatible
   * /v1 endpoint. The /v1 endpoint silently ignores num_ctx and caps context at
   * ~4096 tokens, which truncates long conversations / file reads and makes the
   * model return nothing. The native endpoint honours options.num_ctx, so we
   * can use the model's real context window (config: model.context_tokens).
   */
  async generate(messages: Message[], options: ModelOptions = {}): Promise<GenerateResult> {
    const opts: Record<string, unknown> = {
      temperature: options.temperature ?? this.cfg.temperature,
      top_p: options.top_p ?? this.cfg.topP,
      num_predict: options.max_tokens ?? this.cfg.maxTokens,
      num_ctx: this.cfg.contextTokens ?? 8192,
      ...(options.stop ? { stop: options.stop } : {}),
    };
    // GPU acceleration: only pin num_gpu when the user forces a layer count.
    // Left unset (gpu_layers = -1), Ollama auto-loads as many layers as fit in
    // VRAM and runs the rest on CPU/RAM — automatic offload for large contexts.
    if (typeof this.cfg.gpuLayers === "number" && this.cfg.gpuLayers >= 0) {
      opts.num_gpu = this.cfg.gpuLayers;
    }
    if (this.cfg.lowVram) opts.low_vram = true;

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: nativeMessages(messages),
      stream: false,
      options: opts,
      ...(this.cfg.keepAlive ? { keep_alive: this.cfg.keepAlive } : {}),
    };
    if (options.json) body.format = "json";
    // Reasoning models (R1/QwQ): Ollama returns the chain-of-thought in a
    // separate `thinking` field when asked, instead of inline <think> tags.
    if (options.think) body.think = true;
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const res = await fetch(`${this.root()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      throw new Error(`${this.name} HTTP ${res.status}: ${detail}`);
    }
    const json: any = await res.json();
    const msg: any = json?.message ?? {};
    return {
      text: msg?.content ?? "",
      thinking: typeof msg?.thinking === "string" ? msg.thinking : undefined,
      toolCalls: parseNativeToolCalls(msg?.tool_calls),
      model: this.cfg.model,
      promptTokens: json?.prompt_eval_count,
      completionTokens: json?.eval_count,
    };
  }

  /**
   * Stream via Ollama's NATIVE /api/chat (newline-delimited JSON, NOT SSE).
   * Each line is a JSON object with message.content deltas; the final line
   * carries done:true plus prompt_eval_count / eval_count for exact usage.
   * Counting eval_count live gives the real token-by-token climb.
   */
  async stream(
    messages: Message[],
    onChunk: (delta: string) => void,
    options: ModelOptions = {}
  ): Promise<GenerateResult> {
    const opts: Record<string, unknown> = {
      temperature: options.temperature ?? this.cfg.temperature,
      top_p: options.top_p ?? this.cfg.topP,
      num_predict: options.max_tokens ?? this.cfg.maxTokens,
      num_ctx: this.cfg.contextTokens ?? 8192,
      ...(options.stop ? { stop: options.stop } : {}),
    };
    if (typeof this.cfg.gpuLayers === "number" && this.cfg.gpuLayers >= 0) {
      opts.num_gpu = this.cfg.gpuLayers;
    }
    if (this.cfg.lowVram) opts.low_vram = true;

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: nativeMessages(messages),
      stream: true,
      options: opts,
      ...(this.cfg.keepAlive ? { keep_alive: this.cfg.keepAlive } : {}),
    };
    if (options.json) body.format = "json";
    if (options.think) body.think = true;
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const res = await fetch(`${this.root()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      throw new Error(`${this.name} HTTP ${res.status}: ${detail}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let thinking = "";
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let toolCalls: ToolCall[] | undefined;

    for await (const chunk of res.body as any) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj: any = JSON.parse(trimmed);
          const msg = obj?.message ?? {};
          if (typeof msg.content === "string" && msg.content) {
            full += msg.content;
            onChunk(msg.content);
          }
          if (typeof msg.thinking === "string") thinking += msg.thinking;
          const tc = parseNativeToolCalls(msg.tool_calls);
          if (tc) toolCalls = tc;
          if (obj.done) {
            promptTokens = obj.prompt_eval_count ?? promptTokens;
            completionTokens = obj.eval_count ?? completionTokens;
          }
        } catch {
          /* partial frame */
        }
      }
    }
    if (completionTokens === undefined && full) completionTokens = this.countTokens(full);
    return {
      text: full,
      thinking: thinking.trim() || undefined,
      toolCalls,
      model: this.cfg.model,
      promptTokens,
      completionTokens,
    };
  }

  /** Use Ollama's native /api/tags so we get sizes alongside names. */
  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.root()}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: any = await res.json();
    return (json?.models ?? [])
      .map((m: any) => ({ name: m.name as string, size: formatBytes(m.size) }))
      .filter((m: ModelInfo) => m.name)
      .sort((a: ModelInfo, b: ModelInfo) => a.name.localeCompare(b.name));
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const root = this.root();
    try {
      const res = await fetch(`${root}/api/tags`);
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      const json: any = await res.json();
      const names = (json?.models ?? []).map((m: any) => m.name).join(", ");
      const has = names.includes(this.cfg.model);
      return {
        ok: true,
        detail: has
          ? undefined
          : `reachable, but "${this.cfg.model}" is not pulled (have: ${names || "none"})`,
      };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}

/** Map our Message[] to Ollama's native /api/chat wire format. */
function nativeMessages(messages: Message[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content, ...(m.name ? { tool_name: m.name } : {}) };
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant",
        content: m.content || "",
        tool_calls: m.tool_calls.map((tc) => ({
          function: { name: tc.name, arguments: tc.arguments ?? {} },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** Native tool_calls carry `arguments` as an object (sometimes a JSON string). */
function parseNativeToolCalls(raw: any): ToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const calls: ToolCall[] = [];
  for (let i = 0; i < raw.length; i++) {
    const fn = raw[i]?.function;
    if (!fn?.name) continue;
    let args: Record<string, any> = {};
    if (typeof fn.arguments === "string") {
      try {
        args = JSON.parse(fn.arguments || "{}");
      } catch {
        args = { _raw: fn.arguments };
      }
    } else {
      args = fn.arguments ?? {};
    }
    calls.push({ id: raw[i].id || `call_${i}`, name: fn.name, arguments: args });
  }
  return calls.length ? calls : undefined;
}

function formatBytes(bytes?: number): string | undefined {
  if (!bytes || bytes <= 0) return undefined;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
