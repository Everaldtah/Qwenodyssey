import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VLLMProvider } from "../src/providers/vllm";
import { Spinner, formatTokens } from "../src/cli/render";

/**
 * Build a fake fetch Response whose body is an async-iterable yielding the
 * given SSE chunks as Uint8Arrays — mimicking Node 18+ fetch streaming.
 */
function sseResponse(chunks: string[]): any {
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      const enc = new TextEncoder();
      for (const c of chunks) yield enc.encode(c);
    })(),
  };
}

const cfg = {
  model: "test-model",
  baseUrl: "http://localhost:8000",
  temperature: 0.2,
  topP: 1,
  maxTokens: 256,
};

describe("OpenAI-compatible streaming", () => {
  let origFetch: any;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("accumulates content deltas and emits them via onChunk", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":", "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\n',
        "data: [DONE]\n\n",
      ])
    ) as any;

    const p = new VLLMProvider(cfg as any);
    const seen: string[] = [];
    const res = await p.stream(
      [{ role: "user", content: "hi" }],
      (d) => seen.push(d)
    );
    expect(seen).toEqual(["Hello", ", ", "world"]);
    expect(res.text).toBe("Hello, world");
    expect(res.promptTokens).toBe(11);
    expect(res.completionTokens).toBe(3);
  });

  it("survives a content delta split across two network chunks", async () => {
    // The JSON frame is broken mid-way between two fetch chunks; the parser
    // must buffer the partial line and only parse once the newline arrives.
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"con',
        'tent":"split"}}]}\n\n',
        "data: [DONE]\n\n",
      ])
    ) as any;
    const p = new VLLMProvider(cfg as any);
    const seen: string[] = [];
    const res = await p.stream([{ role: "user", content: "x" }], (d) => seen.push(d));
    expect(res.text).toBe("split");
    expect(seen).toEqual(["split"]);
  });

  it("assembles tool calls streamed as fragments", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"run_shell"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\":\\"ls"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":" -la\\"}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ])
    ) as any;
    const p = new VLLMProvider(cfg as any);
    const res = await p.stream([{ role: "user", content: "list" }], () => {});
    expect(res.toolCalls).toBeDefined();
    expect(res.toolCalls![0].name).toBe("run_shell");
    expect(res.toolCalls![0].arguments).toEqual({ command: "ls -la" });
  });

  it("falls back to a heuristic completion count when no usage frame arrives", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"some output text here"}}]}\n\n',
        "data: [DONE]\n\n",
      ])
    ) as any;
    const p = new VLLMProvider(cfg as any);
    const res = await p.stream([{ role: "user", content: "x" }], () => {});
    expect(res.completionTokens).toBeGreaterThan(0);
  });
});

describe("countTokens heuristic", () => {
  const p = new VLLMProvider(cfg as any);
  it("returns 0 for empty", () => {
    expect(p.countTokens("")).toBe(0);
  });
  it("monotonically increases with length", () => {
    const a = p.countTokens("hello");
    const b = p.countTokens("hello world this is longer");
    expect(b).toBeGreaterThan(a);
  });
  it("counts CJK roughly per-character", () => {
    const n = p.countTokens("你好世界"); // 4 ideographs
    expect(n).toBeGreaterThanOrEqual(4);
  });
  it("is in a sane range for a code snippet", () => {
    const code = "function add(a, b) { return a + b; }";
    const n = p.countTokens(code);
    // ~12–18 tokens for a real BPE tokenizer; allow a generous band.
    expect(n).toBeGreaterThan(8);
    expect(n).toBeLessThan(30);
  });
});

describe("formatTokens", () => {
  it("formats small and large counts", () => {
    expect(formatTokens(5)).toBe("5");
    expect(formatTokens(512)).toBe("512");
    expect(formatTokens(9601)).toBe("9.6k");
    expect(formatTokens(12000)).toBe("12k");
  });
});

describe("Spinner live token counter", () => {
  it("tracks cumulative output tokens via bumpOut/setOut without a TTY", () => {
    // Not a TTY in tests, so draw() no-ops, but the internal counters still
    // update — which is what the meter reconciliation relies on.
    const sp = new Spinner("Testing", 100);
    expect(() => {
      sp.bumpOut(1);
      sp.bumpOut(2);
      sp.setOut(50);
      sp.setUp(120);
      sp.stop();
    }).not.toThrow();
  });
});
