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
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: nativeMessages(messages),
      stream: false,
      options: {
        temperature: options.temperature ?? this.cfg.temperature,
        top_p: options.top_p ?? this.cfg.topP,
        num_predict: options.max_tokens ?? this.cfg.maxTokens,
        num_ctx: this.cfg.contextTokens ?? 8192,
        ...(options.stop ? { stop: options.stop } : {}),
      },
    };
    if (options.json) body.format = "json";
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
      toolCalls: parseNativeToolCalls(msg?.tool_calls),
      model: this.cfg.model,
      promptTokens: json?.prompt_eval_count,
      completionTokens: json?.eval_count,
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
