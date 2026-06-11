/**
 * Anthropic (Claude) backend — the NATIVE Messages API (`/v1/messages`), not an
 * OpenAI-compatible shim. Claude's wire format differs from OpenAI's: the system
 * prompt is a top-level field, tools use `input_schema`, and tool calls/results
 * are `tool_use` / `tool_result` content blocks. We translate Qwenodyssey's
 * internal OpenAI-shaped Message[]/ToolCall[] to and from that format here.
 *
 * Auth supports both worlds:
 *  - **OAuth bearer** (a Claude Pro/Max subscription, the way Claude Code / `ant`
 *    authenticate): `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20`.
 *    The token is short-lived, so a `refreshAuth` thunk (wired to
 *    `ant auth print-credentials`) re-mints it on a 401.
 *  - **API key** (console.anthropic.com, pay-as-you-go): `x-api-key: <key>`.
 *
 * We deliberately send NO sampling params (temperature/top_p) and NO `thinking`
 * config: Opus 4.7/4.8 and Fable 5 reject temperature/top_p and `budget_tokens`
 * with a 400, and omitting `thinking` is valid on every current model (Fable
 * always thinks; its thinking blocks carry empty text and we read text only).
 */
import { OpenAICompatibleProvider, ProviderConfig } from "./base";
import type { GenerateResult, Message, ModelInfo, ModelOptions, ToolCall } from "../types";

const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";

export class AnthropicProvider extends OpenAICompatibleProvider {
  readonly name = "anthropic";
  /** Live OAuth bearer token (re-minted on 401 via cfg.refreshAuth). */
  private token?: string;

  constructor(cfg: ProviderConfig) {
    super(cfg);
    this.token = cfg.authToken;
  }

  /** `https://api.anthropic.com` → `https://api.anthropic.com/v1`. */
  protected apiBase(): string {
    const b = this.cfg.baseUrl.replace(/\/+$/, "");
    return b.endsWith("/v1") ? b : b + "/v1";
  }

  protected headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
    };
    if (this.token) {
      // OAuth (subscription) path — same as Claude Code / `ant`.
      h["Authorization"] = `Bearer ${this.token}`;
      h["anthropic-beta"] = OAUTH_BETA;
    } else if (this.cfg.apiKey) {
      h["x-api-key"] = this.cfg.apiKey;
    }
    return h;
  }

  /** Models API works under both auth modes. */
  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.apiBase()}/models`, { headers: this.headers() });
    if (!res.ok) throw new Error(`${this.name} HTTP ${res.status}`);
    const json: any = await res.json();
    return (json?.data ?? []).map((m: any) => ({ name: m.id })).filter((m: ModelInfo) => m.name);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(`${this.apiBase()}/models`, { headers: this.headers() });
      return { ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /** Build the Anthropic Messages request body from our internal messages. */
  private anthropicBody(messages: Message[], options: ModelOptions, stream: boolean): Record<string, unknown> {
    const { system, msgs } = toAnthropicMessages(messages);
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      max_tokens: options.max_tokens ?? this.cfg.maxTokens ?? 4096,
      messages: msgs,
      stream,
    };
    if (system) body.system = system;
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    return body;
  }

  /** Re-mint the OAuth token (if a refresher is wired) and report whether it changed. */
  private tryRefresh(): boolean {
    const fresh = this.cfg.refreshAuth?.();
    if (fresh && fresh !== this.token) {
      this.token = fresh;
      return true;
    }
    return false;
  }

  async generate(messages: Message[], options: ModelOptions = {}): Promise<GenerateResult> {
    const send = () =>
      this.fetchWithTimeout(`${this.apiBase()}/messages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.anthropicBody(messages, options, false)),
      });
    let res = await send();
    if (res.status === 401 && this.tryRefresh()) res = await send(); // OAuth token expired → refresh once
    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`${this.name} HTTP ${res.status}: ${detail}`);
    }
    const json: any = await res.json();
    const { text, toolCalls } = parseContent(json?.content);
    return {
      text,
      toolCalls,
      model: this.cfg.model,
      promptTokens: json?.usage?.input_tokens,
      completionTokens: json?.usage?.output_tokens,
    };
  }

  async stream(
    messages: Message[],
    onChunk: (delta: string) => void,
    options: ModelOptions = {}
  ): Promise<GenerateResult> {
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

    const open = () =>
      fetch(`${this.apiBase()}/messages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.anthropicBody(messages, options, true)),
        signal: ctrl.signal,
      });

    let res: Response;
    try {
      res = await open();
      if (res.status === 401 && this.tryRefresh()) res = await open();
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
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    // Per content-block accumulator: text blocks stream text_delta; tool_use
    // blocks stream their JSON arguments as input_json_delta fragments.
    const blocks = new Map<number, { type: string; id: string; name: string; json: string }>();

    try {
      for await (const chunk of res.body as any) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue; // ignore `event:` lines
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let obj: any;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }
          switch (obj.type) {
            case "message_start":
              promptTokens = obj.message?.usage?.input_tokens ?? promptTokens;
              break;
            case "content_block_start": {
              const cb = obj.content_block ?? {};
              blocks.set(obj.index ?? 0, { type: cb.type, id: cb.id ?? "", name: cb.name ?? "", json: "" });
              break;
            }
            case "content_block_delta": {
              const d = obj.delta ?? {};
              if (d.type === "text_delta" && d.text) {
                full += d.text;
                onChunk(d.text);
              } else if (d.type === "input_json_delta" && d.partial_json) {
                const b = blocks.get(obj.index ?? 0);
                if (b) b.json += d.partial_json;
              }
              break;
            }
            case "message_delta":
              completionTokens = obj.usage?.output_tokens ?? completionTokens;
              break;
          }
        }
      }
    } catch (err) {
      if (ext?.aborted) throw new Error("__interrupted__");
      throw err;
    } finally {
      if (ext) ext.removeEventListener("abort", onExt);
    }

    if (completionTokens === undefined && full) completionTokens = this.countTokens(full);
    const toolCalls: ToolCall[] = [];
    for (const [idx, b] of [...blocks.entries()].sort((a, c) => a[0] - c[0])) {
      if (b.type !== "tool_use" || !b.name) continue;
      let args: Record<string, any> = {};
      try {
        args = b.json ? JSON.parse(b.json) : {};
      } catch {
        args = { _raw: b.json };
      }
      toolCalls.push({ id: b.id || `call_${idx}`, name: b.name, arguments: args });
    }
    return {
      text: full,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      model: this.cfg.model,
      promptTokens,
      completionTokens,
    };
  }
}

/** Parse a non-streamed `content` array into text + tool calls. */
export function parseContent(content: any): { text: string; toolCalls?: ToolCall[] } {
  if (!Array.isArray(content)) return { text: "" };
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (block?.type === "text") text += block.text ?? "";
    else if (block?.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
    }
  }
  return { text, toolCalls: toolCalls.length ? toolCalls : undefined };
}

/**
 * Translate internal Message[] → Anthropic `{system, messages}`. System turns are
 * folded into the top-level `system` string; assistant tool calls become
 * `tool_use` blocks; `tool` results become `tool_result` blocks in a user turn.
 * Orphan tool results (whose tool_use was dropped by compaction) degrade to plain
 * user text so the request stays valid instead of 400-ing.
 */
export function toAnthropicMessages(messages: Message[]): { system: string; msgs: any[] } {
  const systemParts: string[] = [];
  const msgs: any[] = [];
  const knownToolUseIds = new Set<string>();

  for (const m of messages) {
    if (m.role === "system") {
      if (m.content?.trim()) systemParts.push(m.content);
      continue;
    }
    if (m.role === "assistant") {
      const content: any[] = [];
      if (m.content?.trim()) content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        knownToolUseIds.add(tc.id);
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments ?? {} });
      }
      if (content.length) msgs.push({ role: "assistant", content });
      continue;
    }
    if (m.role === "tool") {
      if (m.tool_call_id && knownToolUseIds.has(m.tool_call_id)) {
        msgs.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content ?? "" }],
        });
      } else {
        // Orphaned result (e.g. after history compaction) — keep it as context.
        msgs.push({ role: "user", content: [{ type: "text", text: `[tool result] ${m.content ?? ""}` }] });
      }
      continue;
    }
    // user
    msgs.push({ role: "user", content: [{ type: "text", text: m.content ?? "" }] });
  }
  return { system: systemParts.join("\n\n"), msgs };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}
