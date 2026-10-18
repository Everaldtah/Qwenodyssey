import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VLLMProvider } from "../src/providers/vllm";
import { NvidiaNimProvider } from "../src/providers/nvidia";
import { OpenRouterProvider } from "../src/providers/openrouter";

/**
 * Regression tests for the "switch models → terminal stuck" bug (2026-10-18):
 * a hosted model that accepts a request and never answers held the turn for
 * the full timeout, Esc was ignored on the blocking path, and the fallback
 * chain re-tried models that had already failed.
 */
const cfg = { model: "test-model", baseUrl: "http://localhost:8000", temperature: 0.2, topP: 1, maxTokens: 8192 };

function errorResponse(status: number, detail: string): any {
  return { ok: false, status, body: null, text: async () => detail };
}

/** fetch that never resolves until its signal aborts (a backend that never answers). */
function hangingFetch() {
  return vi.fn(
    (_url: string, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          (e as any).name = "AbortError";
          reject(e);
        });
      })
  );
}

describe("model switch freeze fixes", () => {
  let origFetch: any;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("generate(): Esc (the caller's signal) interrupts a request that never answers", async () => {
    globalThis.fetch = hangingFetch() as any;
    const p = new VLLMProvider({ ...cfg, requestTimeoutMs: 90_000 });
    const ctrl = new AbortController();
    const pending = p.generate([{ role: "user", content: "hi" }], { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await expect(pending).rejects.toThrow("__interrupted__");
  });

  it("probe(): a backend that never sends headers is aborted by the caller's timeout", async () => {
    globalThis.fetch = hangingFetch() as any;
    const p = new NvidiaNimProvider({ ...cfg, model: "z-ai/glm-5.3" });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    await expect(p.probe(ctrl.signal)).rejects.toThrow("__interrupted__");
  });

  it("probe(): resolves on HTTP 200 without reading the body", async () => {
    const cancel = vi.fn(async () => {});
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, body: { cancel } })) as any;
    const p = new NvidiaNimProvider({ ...cfg, model: "nvidia/nemotron-3-ultra-550b-a55b" });
    await expect(p.probe(new AbortController().signal)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalled();
  });

  it("probe(): surfaces the server error", async () => {
    globalThis.fetch = vi.fn(async () => errorResponse(404, "Function not found for account")) as any;
    const p = new NvidiaNimProvider({ ...cfg, model: "moonshotai/kimi-k2.6" });
    await expect(p.probe(new AbortController().signal)).rejects.toThrow(/HTTP 404/);
  });

  it("NIM Nemotron: a rejected reasoning_budget is dropped and the request retried", async () => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.reasoning_budget) {
        return errorResponse(400, "ValueError: thinking_token_budget is not yet supported by the V2 model runner.");
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "hey" } }] }) };
    }) as any;
    const p = new NvidiaNimProvider({ ...cfg, model: "nvidia/nemotron-3-ultra-550b-a55b", reasoningBudget: 4096 });
    const r = await p.generate([{ role: "user", content: "hi" }]);
    expect(r.text).toBe("hey");
    expect(bodies).toHaveLength(2);
    expect(bodies[1].reasoning_budget).toBeUndefined();
    // Remembered for the rest of the session: the next request skips the budget.
    await p.generate([{ role: "user", content: "again" }]);
    expect(bodies).toHaveLength(3);
    expect(bodies[2].reasoning_budget).toBeUndefined();
  });

  it("OpenRouter 402 'can only afford N': retried once within the affordable budget", async () => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.max_tokens > 3436) {
        return errorResponse(402, "You requested up to 8192 tokens, but can only afford 3436.");
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    }) as any;
    const p = new OpenRouterProvider({ ...cfg, model: "qwen/qwen-2.5-coder-32b-instruct" });
    const r = await p.generate([{ role: "user", content: "hi" }]);
    expect(r.text).toBe("ok");
    expect(bodies[1].max_tokens).toBe(3436 - 64);
  });

  it("stream(): a body that goes silent after the headers is aborted as stalled", async () => {
    globalThis.fetch = vi.fn(async (_url: string, init: any) => ({
      ok: true,
      status: 200,
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"he"}}]}\n');
        await new Promise((_r, reject) =>
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))
        );
      })(),
    })) as any;
    const p = new VLLMProvider({ ...cfg, requestTimeoutMs: 50 });
    await expect(p.stream([{ role: "user", content: "hi" }], () => {})).rejects.toThrow(/stalled/);
  });
});
