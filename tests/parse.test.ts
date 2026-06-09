import { describe, it, expect } from "vitest";
import { extractJson, extractAllJson } from "../src/core/parse";

describe("extractJson", () => {
  it("parses bare JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses fenced JSON with prose around it", () => {
    const text = 'Sure! Here it is:\n```json\n{"edits": [], "notes": "ok"}\n```\nDone.';
    expect(extractJson(text)).toEqual({ edits: [], notes: "ok" });
  });

  it("recovers a balanced object embedded in prose", () => {
    const text = 'The plan is {"goal":"x","steps":[{"index":1,"title":"t"}]} and that is all.';
    const out = extractJson<any>(text);
    expect(out.goal).toBe("x");
    expect(out.steps[0].title).toBe("t");
  });

  it("tolerates trailing commas", () => {
    expect(extractJson('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
  });

  it("returns undefined when there is no JSON", () => {
    expect(extractJson("just words")).toBeUndefined();
  });
});

describe("extractAllJson", () => {
  it("recovers a tool call a coder model emitted as a ```json fence", () => {
    const text = '```json\n{"name": "shell_help", "arguments": {"query": "network tests"}}\n```';
    expect(extractAllJson(text)).toEqual([
      { name: "shell_help", arguments: { query: "network tests" } },
    ]);
  });

  it("recovers multiple JSON values across separate fences in order", () => {
    const text =
      'first:\n```json\n{"name":"run_shell","arguments":{"command":"ls"}}\n```\n' +
      'then:\n```json\n{"name":"update_plan","arguments":{}}\n```';
    const out = extractAllJson(text);
    expect(out.map((o) => o.name)).toEqual(["run_shell", "update_plan"]);
  });

  it("recovers a bare object embedded in prose", () => {
    const text = 'Sure! {"name":"run_shell","arguments":{"command":"echo hi"}}';
    expect(extractAllJson(text)).toEqual([
      { name: "run_shell", arguments: { command: "echo hi" } },
    ]);
  });

  it("returns an empty list for plain prose", () => {
    expect(extractAllJson("the time is 14:05, no json here")).toEqual([]);
  });
});
