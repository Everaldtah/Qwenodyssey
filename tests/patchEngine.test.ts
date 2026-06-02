import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyEdits, rollback, previewEdit } from "../src/core/patchEngine";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qo-patch-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("patchEngine", () => {
  it("creates a file and can roll it back", () => {
    const outcome = applyEdits(dir, [
      { path: "hello.txt", mode: "create", content: "hi\n" },
    ]);
    expect(outcome.allOk).toBe(true);
    expect(fs.readFileSync(path.join(dir, "hello.txt"), "utf-8")).toBe("hi\n");

    rollback(dir, outcome.journalFile!);
    expect(fs.existsSync(path.join(dir, "hello.txt"))).toBe(false);
  });

  it("rewrites a file and restores the previous content on rollback", () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "original\n");
    const outcome = applyEdits(dir, [
      { path: "a.txt", mode: "rewrite", content: "changed\n" },
    ]);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf-8")).toBe("changed\n");
    rollback(dir, outcome.journalFile!);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf-8")).toBe("original\n");
  });

  it("previewEdit produces a unified diff for a rewrite", () => {
    fs.writeFileSync(path.join(dir, "b.txt"), "one\n");
    const diff = previewEdit(dir, { path: "b.txt", mode: "rewrite", content: "two\n" });
    expect(diff).toContain("-one");
    expect(diff).toContain("+two");
  });

  it("reports failure when a unified diff does not apply", () => {
    fs.writeFileSync(path.join(dir, "c.txt"), "real content\n");
    const badDiff =
      "Index: c.txt\n===\n--- c.txt\n+++ c.txt\n@@ -1,1 +1,1 @@\n-nonexistent line\n+replacement\n";
    const outcome = applyEdits(dir, [{ path: "c.txt", mode: "patch", diff: badDiff }]);
    expect(outcome.allOk).toBe(false);
    expect(outcome.applied[0].ok).toBe(false);
  });
});
