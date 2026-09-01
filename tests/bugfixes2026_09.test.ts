import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { VLLMProvider } from "../src/providers/vllm";
import { NvidiaNimProvider } from "../src/providers/nvidia";
import { describeApiError } from "../src/providers/base";
import { stripRedundantCwdPrefix, stripRedundantCwdPrefixInCommand, resolveReadable } from "../src/tools/fileTools";
import { defaultConfig } from "../src/core/config";
import { adaptChainsForPowerShell } from "../src/core/psCompat";
import { applyBlockToContent } from "../src/core/editBlock";
import { replaceSelfAwareness } from "../src/cli/commands/chat";

/** Fake streaming Response: async-iterable body yielding SSE chunks. */
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

const cfg = { model: "test-model", baseUrl: "http://localhost:8000", temperature: 0.2, topP: 1, maxTokens: 256 };

describe("in-band API error frames (NIM 503 inside an HTTP 200 stream)", () => {
  let origFetch: any;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("stream(): an error frame throws instead of yielding an empty reply", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"error":{"message":"Service temporarily overloaded","type":"service_unavailable","code":503}}\n\n',
        "data: [DONE]\n\n",
      ])
    ) as any;
    const p = new VLLMProvider(cfg as any);
    await expect(p.stream([{ role: "user", content: "hi" }], () => {})).rejects.toThrow(/overloaded/);
  });

  it("generate(): an error envelope with HTTP 200 throws", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: { message: "Function not found for account", code: 404 } }),
    })) as any;
    const p = new VLLMProvider(cfg as any);
    await expect(p.generate([{ role: "user", content: "hi" }])).rejects.toThrow(/404 Function not found/);
  });

  it("stream(): reasoning_content deltas are kept as `thinking`, not dropped", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"user said hi. "}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"greet back."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hey!"}}]}\n\n',
        "data: [DONE]\n\n",
      ])
    ) as any;
    const p = new VLLMProvider(cfg as any);
    const res = await p.stream([{ role: "user", content: "hi" }], () => {});
    expect(res.text).toBe("Hey!");
    expect(res.thinking).toBe("user said hi. greet back.");
  });

  it("generate(): reasoning_content is surfaced as `thinking`", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "Hey!", reasoning_content: "casual greeting" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    })) as any;
    const p = new VLLMProvider(cfg as any);
    const res = await p.generate([{ role: "user", content: "hi" }]);
    expect(res.text).toBe("Hey!");
    expect(res.thinking).toBe("casual greeting");
  });

  it("describeApiError renders objects and strings", () => {
    expect(describeApiError("boom")).toBe("boom");
    expect(describeApiError({ code: 503, type: "service_unavailable", message: "overloaded" })).toBe(
      "503 service_unavailable overloaded"
    );
    expect(describeApiError({ weird: 1 })).toBe('{"weird":1}');
  });
});

describe("NVIDIA NIM request shaping", () => {
  let origFetch: any;
  let lastBody: any;
  beforeEach(() => {
    origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      lastBody = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) };
    }) as any;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  const base = { baseUrl: "https://integrate.api.nvidia.com", apiKey: "k", temperature: 0.2, topP: 1, maxTokens: 64 };

  it("omits reasoning_budget for Nemotron by default (NIM rejects it with HTTP 400)", async () => {
    const p = new NvidiaNimProvider({ ...base, model: "nvidia/nemotron-3-ultra-550b-a55b", nemotronThinking: true } as any);
    await p.generate([{ role: "user", content: "hi" }]);
    expect(lastBody.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(lastBody).not.toHaveProperty("reasoning_budget");
  });

  it("sends reasoning_budget only when explicitly configured", async () => {
    const p = new NvidiaNimProvider({
      ...base,
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      nemotronThinking: true,
      reasoningBudget: 2048,
    } as any);
    await p.generate([{ role: "user", content: "hi" }]);
    expect(lastBody.reasoning_budget).toBe(2048);
  });

  it("config default for nvidia.reasoning_budget is 0 (= not sent)", () => {
    expect(defaultConfig().nvidia.reasoning_budget).toBe(0);
  });
});

describe("redundant '<project folder>/' prefix repair for small models", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qo-prefix-"));
  const cwd = path.join(root, "projA");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "calc.py"), "x = 1\n");
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("strips the cwd folder name when no such sub-folder exists", () => {
    expect(stripRedundantCwdPrefix(cwd, "projA/calc.py")).toBe("calc.py");
    expect(stripRedundantCwdPrefix(cwd, "./projA\\calc.py")).toBe("calc.py");
    expect(stripRedundantCwdPrefix(cwd, "projA/")).toBe(".");
    expect(stripRedundantCwdPrefix(cwd, "projA")).toBe(".");
    expect(stripRedundantCwdPrefix(cwd, "PROJA/calc.py")).toBe("calc.py"); // case-insensitive
  });

  it("leaves other paths, absolute paths and ~ paths alone", () => {
    expect(stripRedundantCwdPrefix(cwd, "calc.py")).toBe("calc.py");
    expect(stripRedundantCwdPrefix(cwd, "src/projA/x.py")).toBe("src/projA/x.py");
    expect(stripRedundantCwdPrefix(cwd, "~/projA/x")).toBe("~/projA/x");
    const abs = path.join(cwd, "projA", "x");
    expect(stripRedundantCwdPrefix(cwd, abs)).toBe(abs);
  });

  it("keeps the prefix when a real sub-folder of that name exists", () => {
    fs.mkdirSync(path.join(cwd, "projA"));
    try {
      expect(stripRedundantCwdPrefix(cwd, "projA/calc.py")).toBe("projA/calc.py");
    } finally {
      fs.rmdirSync(path.join(cwd, "projA"));
    }
  });

  it("resolveReadable lands on the file the model meant", () => {
    expect(resolveReadable(cwd, "projA/calc.py")).toBe(path.join(cwd, "calc.py"));
  });

  it("rewrites shell commands the same way", () => {
    expect(stripRedundantCwdPrefixInCommand(cwd, "cat projA/calc.py")).toBe("cat calc.py");
    expect(stripRedundantCwdPrefixInCommand(cwd, "tree projA/")).toBe("tree .");
    expect(stripRedundantCwdPrefixInCommand(cwd, "tree projA/ | findstr calc")).toBe("tree . | findstr calc");
    expect(stripRedundantCwdPrefixInCommand(cwd, 'python "projA\\calc.py"')).toBe('python "calc.py"');
    expect(stripRedundantCwdPrefixInCommand(cwd, "cat .\\projA\\calc.py")).toBe("cat calc.py");
    // untouched: unrelated names, and the real cwd used as a bare word
    expect(stripRedundantCwdPrefixInCommand(cwd, "cat other/projA/x")).toBe("cat other/projA/x");
    expect(stripRedundantCwdPrefixInCommand(cwd, "echo projA")).toBe("echo projA");
  });
});

describe("PowerShell 5.1 chain compatibility", () => {
  it("rewrites unquoted && and || into $? checks", () => {
    expect(adaptChainsForPowerShell("python x.py && echo ok")).toBe("python x.py; if ($?) { echo ok }");
    expect(adaptChainsForPowerShell("npm test || echo failed")).toBe("npm test; if (-not $?) { echo failed }");
    expect(adaptChainsForPowerShell("a && b || c")).toBe("a; if ($?) { b }; if (-not $?) { c }");
  });
  it("leaves quoted operators and plain commands alone", () => {
    expect(adaptChainsForPowerShell('echo "a && b"')).toBe('echo "a && b"');
    expect(adaptChainsForPowerShell("Get-Process | Select -First 3")).toBe("Get-Process | Select -First 3");
    expect(adaptChainsForPowerShell("python -c \"print('x' or 'y')\"")).toBe("python -c \"print('x' or 'y')\"");
  });
});

describe("self-modification is opt-in", () => {
  it("tools.allow_self_edit defaults to false", () => {
    expect(defaultConfig().tools.allow_self_edit).toBe(false);
  });
});

describe("apply_edit with an empty search", () => {
  const cur = "def add(a, b):\n    return a + b\n";
  it("replaces the whole file when the replacement already contains it (no duplicate defs)", () => {
    const r = applyBlockToContent(cur, { path: "calc.py", search: "", replace: cur + "\ndef multiply(a, b):\n    return a * b\n" });
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("replaced-whole");
    expect((r.result!.match(/def add/g) || []).length).toBe(1);
    expect(r.result).toContain("def multiply");
  });
  it("still appends genuinely new text", () => {
    const r = applyBlockToContent(cur, { path: "calc.py", search: "", replace: "def multiply(a, b):\n    return a * b\n" });
    expect(r.strategy).toBe("appended");
    expect(r.result).toBe(cur + "def multiply(a, b):\n    return a * b\n");
  });
});

describe("replaceSelfAwareness keeps the rest of the system prompt", () => {
  it("does not clip the prompt when an earlier line merely mentions SELF-AWARENESS", () => {
    const sys =
      "You are a coding agent. Your identity is in the SELF-AWARENESS section below.\n\n" +
      "TOOL RULES: always call tools.\n\nPLAN RULES: keep a plan.\n\n" +
      'SELF-AWARENESS — you are "Qwenodyssey", running on old-model.\n• MODEL: old-model' +
      "\n\nPROJECT:\nfiles: a.py";
    const history = [{ role: "system" as const, content: sys }];
    replaceSelfAwareness(history, 'SELF-AWARENESS — you are "Qwenodyssey", running on new-model.\n• MODEL: new-model');
    const out = history[0].content;
    expect(out).toContain("TOOL RULES: always call tools.");
    expect(out).toContain("PLAN RULES: keep a plan.");
    expect(out).toContain("new-model");
    expect(out).not.toContain("old-model");
    expect(out).toContain("PROJECT:\nfiles: a.py");
    expect(out.indexOf("SELF-AWARENESS section below")).toBeGreaterThan(-1);
  });
});
