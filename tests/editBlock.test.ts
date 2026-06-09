import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import {
  parseEditBlocks,
  applyBlockToContent,
  applyEditBlocks,
  locateBlock,
  similarity,
  explainFailure,
} from "../src/core/editBlock";

describe("parseEditBlocks", () => {
  it("parses a single block with a path line above the fence", () => {
    const text = [
      "Here's the fix:",
      "src/foo.ts",
      "<<<<<<< SEARCH",
      "const x = 1;",
      "=======",
      "const x = 2;",
      ">>>>>>> REPLACE",
    ].join("\n");
    const blocks = parseEditBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].path).toBe("src/foo.ts");
    expect(blocks[0].search).toBe("const x = 1;");
    expect(blocks[0].replace).toBe("const x = 2;");
  });

  it("parses a path from a ```ts path``` fence header", () => {
    const text = [
      "```ts src/bar.ts",
      "<<<<<<< SEARCH",
      "old",
      "=======",
      "new",
      ">>>>>>> REPLACE",
      "```",
    ].join("\n");
    const blocks = parseEditBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].path).toBe("src/bar.ts");
  });

  it("parses multiple blocks and inherits the path for same-file edits", () => {
    const text = [
      "lib/util.py",
      "<<<<<<< SEARCH",
      "a = 1",
      "=======",
      "a = 2",
      ">>>>>>> REPLACE",
      "<<<<<<< SEARCH",
      "b = 3",
      "=======",
      "b = 4",
      ">>>>>>> REPLACE",
    ].join("\n");
    const blocks = parseEditBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].path).toBe("lib/util.py");
    expect(blocks[1].path).toBe("lib/util.py");
  });

  it("handles an empty SEARCH (create/append) block", () => {
    const text = ["newfile.txt", "<<<<<<< SEARCH", "=======", "hello world", ">>>>>>> REPLACE"].join("\n");
    const blocks = parseEditBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("");
    expect(blocks[0].replace).toBe("hello world");
  });
});

describe("locateBlock match strategies", () => {
  const content = ["function add(a, b) {", "    return a + b;", "}", "", "const z = 10;"].join("\n");

  it("finds an exact match", () => {
    const loc = locateBlock(content, "    return a + b;");
    expect(loc?.strategy).toBe("exact");
    expect(loc?.start).toBe(1);
  });

  it("finds a whitespace-tolerant match", () => {
    const loc = locateBlock(content, "return a + b;"); // different indent
    expect(loc).not.toBeNull();
    expect(["whitespace", "anchored-fuzzy"]).toContain(loc!.strategy);
  });

  it("returns null when there is no plausible match", () => {
    const loc = locateBlock(content, "completely unrelated code here xyz");
    expect(loc).toBeNull();
  });
});

describe("applyBlockToContent", () => {
  it("replaces exact content", () => {
    const r = applyBlockToContent("a\nb\nc", { path: "x", search: "b", replace: "B" });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("a\nB\nc");
  });

  it("re-indents a replacement to match the matched region", () => {
    const content = ["class C {", "    method() {", "        return 1;", "    }", "}"].join("\n");
    // Model supplies the search/replace at zero indent; engine should re-flow.
    const r = applyBlockToContent(content, {
      path: "x",
      search: "return 1;",
      replace: "return 42;",
    });
    expect(r.ok).toBe(true);
    expect(r.result).toContain("        return 42;"); // preserved 8-space indent
  });

  it("appends when SEARCH is empty and file has content", () => {
    const r = applyBlockToContent("line1", { path: "x", search: "", replace: "line2" });
    expect(r.result).toBe("line1\nline2");
    expect(r.strategy).toBe("appended");
  });

  it("reports failure when SEARCH is not found", () => {
    const r = applyBlockToContent("a\nb", { path: "x", search: "zzz", replace: "q" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });
});

describe("applyEditBlocks (filesystem)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qod-edit-"));
  const resolve = (rel: string) => {
    const abs = path.resolve(dir, rel);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new Error("escape");
    return abs;
  };

  it("applies multiple blocks to the same file sequentially", () => {
    const f = "code.js";
    fs.writeFileSync(path.join(dir, f), "let a = 1;\nlet b = 2;\n");
    const results = applyEditBlocks(
      [
        { path: f, search: "let a = 1;", replace: "let a = 100;" },
        { path: f, search: "let b = 2;", replace: "let b = 200;" },
      ],
      resolve
    );
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    const out = fs.readFileSync(path.join(dir, f), "utf-8");
    expect(out).toContain("let a = 100;");
    expect(out).toContain("let b = 200;");
  });

  it("creates a new file from an empty-SEARCH block", () => {
    const results = applyEditBlocks([{ path: "fresh.txt", search: "", replace: "brand new" }], resolve);
    expect(results[0].ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "fresh.txt"), "utf-8")).toBe("brand new");
  });

  it("rejects a path that escapes the sandbox", () => {
    const results = applyEditBlocks([{ path: "../escape.txt", search: "", replace: "x" }], resolve);
    expect(results[0].ok).toBe(false);
  });
});

describe("similarity + explainFailure", () => {
  it("scores identical strings as 1 and disjoint near 0", () => {
    expect(similarity("hello", "hello")).toBe(1);
    expect(similarity("hello", "xyzzy")).toBeLessThan(0.4);
  });

  it("points to the closest line on a failed match", () => {
    const content = "function compute(value) {\n  return value * 2;\n}";
    const msg = explainFailure(content, { path: "x", search: "function compute(val) {", replace: "..." });
    expect(msg).toMatch(/compute/);
  });
});
