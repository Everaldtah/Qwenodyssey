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
import { modelProfile, resolveThinking, type ThinkMode } from "../core/modelProfile";

export interface ProviderConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
  temperature: number;
  topP: number;
  /** Optional small-model decoding knobs; omitted from the wire when unset/0. */
  topK?: number;
  repeatPenalty?: number;
  presencePenalty?: number;
  /** Chain-of-thought policy for thinking-capable models (config model.think). */
  think?: ThinkMode;
  maxTokens: number;
  contextTokens?: number;
  gpuLayers?: number;
  lowVram?: boolean;
  keepAlive?: string;
  /** Disable a thinking model's chain-of-thought (sends chat_template_kwargs.thinking=false). */
  disableThinking?: boolean;
  /** Abort a request after this many ms (0/undefined = no timeout). Used for cloud backends. */
  requestTimeoutMs?: number;
  /** Nemotron reasoning models: enable_thinking toggle + reasoning_budget. */
  nemotronThinking?: boolean;
  reasoningBudget?: number;
  /** Anthropic OAuth bearer token (Claude subscription); preferred over apiKey when set. */
  authToken?: string;
  /** Re-mint a short-lived OAuth token on a 401 (e.g. via `ant auth print-credentials`). */
  refreshAuth?: () => string | null;
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

  /**
   * Whether the model should expose a chain-of-thought this turn. An explicit
   * per-request option wins; otherwise the configured policy (model.think) is
   * resolved against the model's family. `undefined` means the model has no
   * thinking mode at all, so the flag stays off the wire entirely.
   */
  protected thinkingEnabled(options: ModelOptions): boolean | undefined {
    if (typeof options.think === "boolean") return options.think;
    return resolveThinking(modelProfile(this.cfg.model), this.cfg.think ?? "auto");
  }

  /**
   * Decoding knobs that are only sent when actually set (0/undefined = leave the
   * choice to the server). These are the levers that keep SMALL models from
   * looping; big hosted models normally leave them unset.
   */
  protected samplingExtras(options: ModelOptions): Record<string, number> {
    const out: Record<string, number> = {};
    const topK = options.top_k ?? this.cfg.topK;
    const presence = options.presence_penalty ?? this.cfg.presencePenalty;
    const repeat = options.repeat_penalty ?? this.cfg.repeatPenalty;
    if (topK && topK > 0) out.top_k = topK;
    if (presence && presence > 0) out.presence_penalty = presence;
    if (repeat && repeat > 0) out.repetition_penalty = repeat;
    return out;
  }

  protected body(messages: Message[], options: ModelOptions, stream: boolean) {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: this.wireMessages(messages),
      temperature: options.temperature ?? this.cfg.temperature,
      top_p: options.top_p ?? this.cfg.topP,
      max_tokens: options.max_tokens ?? this.cfg.maxTokens,
      ...this.samplingExtras(options),
      stream,
    };
    // Hybrid thinking models (Qwen3 / Qwen3.5) are toggled through the chat
    // template: `chat_template_kwargs.enable_thinking`, which LM Studio, vLLM and
    // llama.cpp all honour. The old approach appended a literal " /no_think" to
    // the user message — Qwen 3.5 no longer recognises that switch and small
    // models answered the text itself ("No, I'm not thinking…") instead of the
    // question. Provider-specific extraBody() below may still override this.
    const think = this.thinkingEnabled(options);
    if (typeof think === "boolean" && modelProfile(this.cfg.model).hybridThinking) {
      body.chat_template_kwargs = { enable_thinking: think };
    }
    if (options.stop) body.stop = options.stop;
    if (options.json) body.response_format = { type: "json_object" };
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    Object.assign(body, this.extraBody());
    return body;
  }

  /**
   * Extra provider-specific request-body fields merged into every request
   * (e.g. NVIDIA NIM's `chat_template_kwargs`). Default: none.
   */
  protected extraBody(): Record<string, unknown> {
    return {};
  }

  /**
   * fetch with an optional request timeout (cfg.requestTimeoutMs). A hung/slow
   * endpoint then fails fast with a clear "timed out" error instead of blocking
   * the whole turn — which the chat layer treats as "unavailable" and falls back.
   */
  protected async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const ms = this.cfg.requestTimeoutMs;
    if (!ms || ms <= 0) return fetch(url, init);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      if ((err as any)?.name === "AbortError") {
        throw new Error(`${this.name} request timed out after ${ms}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async generate(
    messages: Message[],
    options: ModelOptions = {}
  ): Promise<GenerateResult> {
    const res = await this.fetchWithTimeout(`${this.apiBase()}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.body(messages, options, false)),
    });
    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`${this.name} HTTP ${res.status}: ${detail}`);
    }
    const json: any = await res.json();
    // Some gateways (NVIDIA NIM) answer HTTP 200 with an error envelope instead
    // of a completion — surface it as a real error so the fallback chain runs.
    if (json?.error) throw new Error(`${this.name} error: ${describeApiError(json.error)}`);
    const msg: any = json?.choices?.[0]?.message ?? {};
    const text: string = msg?.content ?? "";
    const toolCalls = parseToolCalls(msg?.tool_calls);
    // Reasoning models return their chain-of-thought in a separate field
    // (NIM/vLLM: reasoning_content, OpenRouter: reasoning). Keep it so the chat
    // layer can show it and tell "thought but never answered" from "no response".
    const reasoning = msg?.reasoning_content ?? msg?.reasoning;
    return {
      text,
      toolCalls,
      thinking: typeof reasoning === "string" && reasoning.trim() ? reasoning : undefined,
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
    // Interruptible stream: a local controller is aborted either by the request
    // timeout (until headers arrive) or by the caller's Esc-interrupt signal
    // (for the whole stream). We clear the connect timeout once headers land so a
    // legitimately long generation isn't killed.
    const ctrl = new AbortController();
    const ext = options.signal;
    const onExt = () => ctrl.abort();
    if (ext) {
      if (ext.aborted) ctrl.abort();
      else ext.addEventListener("abort", onExt);
    }
    const ms = this.cfg.requestTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | null =
      ms && ms > 0 ? setTimeout(() => ctrl.abort(), ms) : null;
    let res: Response;
    try {
      res = await fetch(`${this.apiBase()}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        // Ask OpenAI-compatible servers to include a final usage frame in the
        // stream (vLLM, llama.cpp, LM Studio, OpenRouter all honor this), so we
        // get EXACT prompt/completion counts even while streaming.
        body: JSON.stringify({
          ...this.body(messages, options, true),
          stream_options: { include_usage: true },
        }),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (ext) ext.removeEventListener("abort", onExt);
      if (ext?.aborted) throw new Error("__interrupted__");
      if ((err as any)?.name === "AbortError") throw new Error(`${this.name} request timed out after ${ms}ms`);
      throw err;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!res.ok || !res.body) {
      if (ext) ext.removeEventListener("abort", onExt);
      const detail = await safeText(res);
      throw new Error(`${this.name} HTTP ${res.status}: ${detail}`);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let thinking = "";
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    // Accumulate streamed tool-call fragments by index (OpenAI streams them as
    // partial deltas: name on the first frame, arguments byte-by-byte after).
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    // Node 18+ fetch body is an async-iterable web stream.
    try {
      for await (const chunk of res.body as any) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;
          let obj: any;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue; /* keep-alive / partial frame */
          }
          // An in-band error frame (e.g. NIM "503 Service temporarily
          // overloaded" delivered inside an HTTP 200 stream) used to be silently
          // skipped, leaving an empty reply with 0 tokens. Fail loudly instead so
          // the chat layer can fall back to another model.
          if (obj?.error) throw new Error(`${this.name} stream error: ${describeApiError(obj.error)}`);
          if (obj?.usage) {
            promptTokens = obj.usage.prompt_tokens ?? promptTokens;
            completionTokens = obj.usage.completion_tokens ?? completionTokens;
          }
          const choice = obj?.choices?.[0];
          const delta: string = choice?.delta?.content ?? "";
          if (delta) {
            full += delta;
            onChunk(delta);
          }
          const reason = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
          if (typeof reason === "string" && reason) thinking += reason;
          const tcs = choice?.delta?.tool_calls;
          if (Array.isArray(tcs)) {
            for (const tc of tcs) {
              const idx = tc.index ?? 0;
              const cur = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.name = tc.function.name;
              if (tc.function?.arguments) cur.args += tc.function.arguments;
              toolAcc.set(idx, cur);
            }
          }
        }
      }
    } catch (err) {
      if (ext?.aborted) throw new Error("__interrupted__");
      throw err;
    } finally {
      if (ext) ext.removeEventListener("abort", onExt);
    }
    // If the server never sent a usage frame, fall back to a heuristic count so
    // callers still get a non-undefined number (better than nothing for budgets).
    if (completionTokens === undefined && full) completionTokens = this.countTokens(full);
    const toolCalls = assembleStreamedToolCalls(toolAcc);
    return {
      text: full,
      toolCalls,
      thinking: thinking.trim() || undefined,
      model: this.cfg.model,
      promptTokens,
      completionTokens,
    };
  }

  /**
   * Estimate token count without a tokenizer dependency. A flat len/4 badly
   * mis-estimates code (many short symbol tokens) and CJK (≈1 token/char), so
   * we approximate BPE behaviour: count word-ish runs, standalone symbols, and
   * CJK characters, then blend with a byte-rate floor. Empirically within
   * ~10–15% of tiktoken/Qwen's tokenizer for mixed code+prose — accurate enough
   * for context budgeting, compaction triggers, and the live meter's seed.
   * Backends that report exact `usage` always override this.
   */
  countTokens(text: string): number {
    const s = text || "";
    if (!s) return 0;
    let cjk = 0;
    // CJK / fullwidth ranges roughly map to ~1 token per character.
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (
        (c >= 0x3040 && c <= 0x30ff) || // kana
        (c >= 0x3400 && c <= 0x9fff) || // CJK ideographs
        (c >= 0xac00 && c <= 0xd7af) || // Hangul
        (c >= 0xf900 && c <= 0xfaff)
      ) {
        cjk++;
      }
    }
    const ascii = s.replace(/[^\x00-\x7f]/g, "");
    // Word-ish chunks (alphanumeric runs) ≈ 1.3 tokens each on average; lone
    // punctuation/operators ≈ 1 token each; whitespace is mostly free.
    const words = (ascii.match(/[A-Za-z0-9_]+/g) || []).length;
    const symbols = (ascii.match(/[^\sA-Za-z0-9_]/g) || []).length;
    const structural = Math.ceil(words * 1.3 + symbols);
    const byteFloor = Math.ceil(ascii.length / 4);
    // Take the larger of the structural and byte-rate estimates, plus CJK.
    return Math.max(structural, byteFloor) + cjk;
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

/** Human-readable text for an OpenAI-style `error` envelope (object or string). */
export function describeApiError(err: unknown): string {
  if (typeof err === "string") return err;
  const e = err as { message?: unknown; code?: unknown; type?: unknown } | null;
  const parts = [e?.code, e?.type, e?.message].filter((x) => x !== undefined && x !== null && x !== "");
  return parts.length ? parts.map(String).join(" ") : JSON.stringify(err);
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

/**
 * Assemble tool calls that arrived as streamed fragments (name on the first
 * frame, arguments concatenated across later frames) into finished ToolCall[].
 */
function assembleStreamedToolCalls(
  acc: Map<number, { id: string; name: string; args: string }>
): ToolCall[] | undefined {
  if (acc.size === 0) return undefined;
  const calls: ToolCall[] = [];
  for (const [idx, c] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!c.name) continue;
    let args: Record<string, any> = {};
    try {
      args = c.args ? JSON.parse(c.args) : {};
    } catch {
      args = { _raw: c.args };
    }
    calls.push({ id: c.id || `call_${idx}`, name: c.name, arguments: args });
  }
  return calls.length ? calls : undefined;
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
