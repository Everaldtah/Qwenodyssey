import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { SymbolIndex } from "../src/core/symbolIndex";
import { repairJson, coerceArray } from "../src/core/repair";
import { bestOfN, SCORE } from "../src/core/candidateSelect";
import { detectChecks, digestErrors } from "../src/core/verifyLoop";

describe("SymbolIndex", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qod-sym-"));
  fs.writeFileSync(
    path.join(dir, "math.ts"),
    [
      "export function add(a: number, b: number) {",
      "  return a + b;",
      "}",
      "",
      "export class Calculator {",
      "  multiply(a: number, b: number) {",
      "    return a * b;",
      "  }",
      "}",
      "",
      "export interface Op { name: string; }",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(dir, "app.py"),
    ["def main():", "    print(add(1, 2))", "", "class Service:", "    def run(self):", "        return main()"].join("\n")
  );

  it("indexes TS functions, classes, interfaces", async () => {
    const idx = new SymbolIndex(dir);
    await idx.build();
    expect(idx.find("add", "function").length).toBe(1);
    expect(idx.find("Calculator", "class").length).toBe(1);
    expect(idx.find("Op", "interface").length).toBe(1);
  });

  it("indexes Python defs and classes", async () => {
    const idx = new SymbolIndex(dir);
    await idx.build();
    expect(idx.find("main", "function").length).toBe(1);
    expect(idx.find("Service", "class").length).toBe(1);
  });

  it("produces a file outline in line order", async () => {
    const idx = new SymbolIndex(dir);
    await idx.build();
    const outline = idx.outline("math.ts");
    expect(outline.map((d) => d.name)).toEqual(["add", "Calculator", "multiply", "Op"]);
  });

  it("finds references and flags definitions", async () => {
    const idx = new SymbolIndex(dir);
    await idx.build();
    const refs = idx.references("add");
    expect(refs.length).toBeGreaterThanOrEqual(2); // def in math.ts + use in app.py
    expect(refs.some((r) => r.isDefinition)).toBe(true);
  });

  it("reads a single symbol body via brace balancing", async () => {
    const idx = new SymbolIndex(dir);
    await idx.build();
    const defs = idx.find("add", "function");
    const body = idx.readSymbol(defs[0]);
    expect(body).toContain("return a + b;");
    expect(body).not.toContain("Calculator");
  });

  it("fuzzy-searches by substring", async () => {
    const idx = new SymbolIndex(dir);
    await idx.build();
    const hits = idx.search("calc");
    expect(hits.some((h) => h.name === "Calculator")).toBe(true);
  });
});

describe("repairJson", () => {
  it("parses already-valid JSON without marking repaired", () => {
    const r = repairJson('{"a":1}');
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(false);
    expect((r.value as any).a).toBe(1);
  });

  it("strips code fences and prose", () => {
    const r = repairJson('Sure! Here you go:\n```json\n{"x": 5}\n```');
    expect(r.ok).toBe(true);
    expect((r.value as any).x).toBe(5);
  });

  it("removes trailing commas", () => {
    const r = repairJson('{"a": 1, "b": [1, 2, 3,],}');
    expect(r.ok).toBe(true);
    expect((r.value as any).b).toEqual([1, 2, 3]);
  });

  it("converts single quotes and bare keys", () => {
    const r = repairJson("{name: 'qwen', n: 7}");
    expect(r.ok).toBe(true);
    expect((r.value as any).name).toBe("qwen");
    expect((r.value as any).n).toBe(7);
  });

  it("closes an unterminated object/string", () => {
    const r = repairJson('{"path": "src/a.ts", "content": "unterminated');
    expect(r.ok).toBe(true);
    expect((r.value as any).path).toBe("src/a.ts");
  });

  it("normalizes python literals", () => {
    const r = repairJson('{"ok": True, "bad": False, "x": None}');
    expect(r.ok).toBe(true);
    expect((r.value as any).ok).toBe(true);
    expect((r.value as any).x).toBe(null);
  });
});

describe("coerceArray", () => {
  it("passes arrays through", () => {
    expect(coerceArray([1, 2])).toEqual([1, 2]);
  });
  it("unwraps a known key", () => {
    expect(coerceArray({ edits: [{ p: 1 }] })).toEqual([{ p: 1 }]);
  });
  it("wraps a bare object", () => {
    expect(coerceArray({ path: "x" })).toEqual([{ path: "x" }]);
  });
});

describe("bestOfN", () => {
  it("selects the highest-scoring candidate", async () => {
    const res = await bestOfN<number>({
      n: 4,
      sample: async (i) => ({ value: i, raw: String(i) }),
      score: async (v) => ({ score: v, reason: `val ${v}` }),
    });
    expect(res.best?.value).toBe(3);
    expect(res.all.length).toBe(4);
  });

  it("rejects -Infinity candidates", async () => {
    const res = await bestOfN<number>({
      n: 3,
      sample: async (i) => ({ value: i, raw: String(i) }),
      score: async (v) => (v === 1 ? { score: SCORE.REJECT, reason: "bad" } : { score: v, reason: "ok" }),
    });
    expect(res.all.some((c) => c.value === 1)).toBe(false);
  });

  it("short-circuits on early-accept", async () => {
    let calls = 0;
    const res = await bestOfN<number>({
      n: 10,
      sample: async (i) => {
        calls++;
        return { value: i, raw: String(i) };
      },
      score: async (v) => ({ score: v >= 0 ? SCORE.ALL_PASS : 0, reason: "" }),
      earlyAcceptScore: SCORE.ALL_PASS,
    });
    expect(res.earlyAccepted).toBe(true);
    expect(calls).toBe(1); // stopped after the first good one
  });

  it("handles a sampler that returns null", async () => {
    const res = await bestOfN<number>({
      n: 2,
      sample: async () => ({ value: null, raw: "" }),
      score: async () => ({ score: 1, reason: "" }),
    });
    expect(res.best).toBeNull();
  });
});

describe("verifyLoop detection + digest", () => {
  it("detects npm test/typecheck scripts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qod-vl-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" }, devDependencies: { typescript: "5" } })
    );
    const checks = detectChecks(dir);
    const kinds = checks.map((c) => c.kind);
    expect(kinds).toContain("test");
    expect(kinds).toContain("typecheck");
  });

  it("detects cargo for a Rust project", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qod-rs-"));
    fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname='x'\n");
    const checks = detectChecks(dir);
    expect(checks.some((c) => c.cmd === "cargo")).toBe(true);
  });

  it("digests errors, prioritizing error-ish lines with file:line", () => {
    const raw = [
      "Compiling...",
      "ok ok ok",
      "src/foo.ts:42:10 - error TS2322: Type 'string' is not assignable to type 'number'.",
      "noise noise",
      "FAILED src/bar.test.ts > does a thing",
    ].join("\n");
    const digest = digestErrors("typecheck", raw);
    expect(digest).toMatch(/src\/foo\.ts:42/);
    expect(digest).toMatch(/FAILED/);
    expect(digest).not.toMatch(/noise/);
  });
});
