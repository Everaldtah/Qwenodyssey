import { describe, it, expect } from "vitest";
import { extractJson } from "../src/core/parse";

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
