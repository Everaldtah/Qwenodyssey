import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { levenshtein, resolveToolName, prepareToolCall } from "../src/tools/toolCallPrep";
import { ShellSession } from "../src/core/shellSession";
import { classifyCommand } from "../src/tools/shellTools";
import { readFileTool } from "../src/tools/fileTools";
import type { ToolContext, ToolSpec } from "../src/types";

const ctx: ToolContext = { cwd: ".", autoConfirm: true, confirmDestructive: false, allowShell: true, sandbox: true, log: () => {} };

const SPECS: ToolSpec[] = [
  {
    name: "read_file",
    description: "read",
    parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" } }, required: ["path"] },
  },
  {
    name: "grep",
    description: "grep",
    parameters: { type: "object", properties: { pattern: { type: "string" }, ignoreCase: { type: "boolean" } }, required: ["pattern"] },
  },
  {
    name: "web_research",
    description: "research",
    parameters: { type: "object", properties: { query: { type: "string" }, pages: { type: "integer" } }, required: ["query"] },
  },
];

describe("toolCallPrep — fuzzy name resolution", () => {
  it("keeps an exact name", () => {
    expect(resolveToolName("grep", ["grep", "read_file"]).name).toBe("grep");
  });
  it("resolves a substring/prefix alias", () => {
    expect(resolveToolName("read", ["read_file", "grep"]).name).toBe("read_file");
  });
  it("resolves a small typo by edit distance", () => {
    expect(resolveToolName("grpe", ["grep", "read_file"]).name).toBe("grep");
  });
  it("returns suggestions when ambiguous/unknown", () => {
    const r = resolveToolName("zzzzzz", ["grep", "read_file", "web_search"]);
    expect(r.name).toBeUndefined();
    expect(r.suggestions.length).toBeGreaterThan(0);
  });
  it("levenshtein basic distances", () => {
    expect(levenshtein("grep", "grep")).toBe(0);
    expect(levenshtein("grpe", "grep")).toBe(2);
  });
});

describe("toolCallPrep — schema coercion + validation", () => {
  it("coerces string types a small model fumbled", () => {
    const p = prepareToolCall("grep", { pattern: "TODO", ignoreCase: "true" }, SPECS);
    expect(p.error).toBeUndefined();
    expect(p.arguments.ignoreCase).toBe(true);
  });
  it("coerces numeric strings to numbers", () => {
    const p = prepareToolCall("web_research", { query: "x", pages: "5" }, SPECS);
    expect(p.arguments.pages).toBe(5);
  });
  it("reports a missing required argument with the tool's shape", () => {
    const p = prepareToolCall("read_file", {}, SPECS);
    expect(p.error).toMatch(/missing required/i);
    expect(p.error).toMatch(/path/);
  });
  it("treats a blank required string as missing", () => {
    const p = prepareToolCall("read_file", { path: "   " }, SPECS);
    expect(p.error).toMatch(/missing required/i);
  });
  it("carries a note when the name was corrected", () => {
    const p = prepareToolCall("read", { path: "a.ts" }, SPECS);
    expect(p.name).toBe("read_file");
    expect(p.note).toMatch(/interpreted/);
  });
  it("errors clearly on a wholly unknown tool", () => {
    const p = prepareToolCall("frobnicate", {}, SPECS);
    expect(p.error).toMatch(/No tool named/);
  });
});

describe("classifyCommand — Windows + allow/deny", () => {
  it("hard-blocks PowerShell catastrophes", () => {
    expect(classifyCommand("Format-Volume -DriveLetter D")).toBe("blocked");
    expect(classifyCommand("Clear-Disk -Number 0")).toBe("blocked");
    expect(classifyCommand("Restart-Computer")).toBe("blocked");
    expect(classifyCommand("reg delete HKLM\\SOFTWARE\\Foo /f")).toBe("blocked");
  });
  it("flags Windows state-changing commands as destructive", () => {
    expect(classifyCommand("Remove-Item foo.txt")).toBe("destructive");
    expect(classifyCommand("takeown /f C:\\x")).toBe("destructive");
    expect(classifyCommand("reg add HKCU\\Foo /v Bar")).toBe("destructive");
  });
  it("deny-list blocks an otherwise-safe command", () => {
    expect(classifyCommand("npm publish", { deny: ["^npm publish"] })).toBe("blocked");
  });
  it("allow-list downgrades a destructive command to safe", () => {
    expect(classifyCommand("rm scratch.txt", { allow: ["^rm scratch"] })).toBe("safe");
  });
  it("allow-list can NEVER override a hard-block", () => {
    expect(classifyCommand("rm -rf /", { allow: ["rm -rf"] })).toBe("blocked");
  });
  it("tolerates an invalid regex by matching it literally", () => {
    expect(classifyCommand("weird(cmd", { deny: ["weird(cmd"] })).toBe("blocked");
  });
});

describe("read_file pagination", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qod-page-"));
  const file = path.join(dir, "big.txt");
  fs.writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"));

  it("returns a window with a next-offset hint when offset/limit are given", async () => {
    const r = await readFileTool.run({ path: file, offset: 10, limit: 5 }, { ...ctx, cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/lines 10-14 of 100/);
    expect(r.output).toContain("line 10");
    expect(r.output).toContain("line 14");
    expect(r.output).not.toContain("line 15");
    expect(r.output).toMatch(/offset=15/);
  });

  it("returns the whole small file unpaginated by default", async () => {
    const small = path.join(dir, "small.txt");
    fs.writeFileSync(small, "a\nb\nc");
    const r = await readFileTool.run({ path: small }, { ...ctx, cwd: dir });
    expect(r.output).toBe("a\nb\nc");
  });
});

describe("ShellSession graceful degradation", () => {
  it("reports a helpful error (not a crash) when node-pty is unavailable", async () => {
    const sess = new ShellSession(process.cwd());
    const r = await sess.run("echo hi", 1000);
    // When node-pty is installed this runs; when it isn't, run() returns a clean
    // error telling the user to install it. Either way it must never throw.
    expect(["done", "running", "error"]).toContain(r.status);
    if (r.status === "error") expect(r.output).toMatch(/node-pty/);
    sess.dispose();
  });
});
