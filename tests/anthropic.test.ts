import { describe, it, expect } from "vitest";
import { toAnthropicMessages, parseContent, AnthropicProvider } from "../src/providers/anthropic";
import type { Message } from "../src/types";

describe("toAnthropicMessages — OpenAI-shape → Claude Messages", () => {
  it("folds system turns into the top-level system field", () => {
    const { system, msgs } = toAnthropicMessages([
      { role: "system", content: "You are Qwenodyssey." },
      { role: "user", content: "hi" },
    ]);
    expect(system).toBe("You are Qwenodyssey.");
    expect(msgs).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("maps assistant tool_calls to tool_use blocks and tool results to tool_result", () => {
    const history: Message[] = [
      { role: "user", content: "what's the weather" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", name: "get_weather", arguments: { city: "Paris" } }],
      },
      { role: "tool", tool_call_id: "call_1", name: "get_weather", content: "18C sunny" },
      { role: "assistant", content: "It's 18C and sunny in Paris." },
    ];
    const { msgs } = toAnthropicMessages(history);
    expect(msgs[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } }],
    });
    expect(msgs[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "18C sunny" }],
    });
    expect(msgs[3]).toEqual({ role: "assistant", content: [{ type: "text", text: "It's 18C and sunny in Paris." }] });
  });

  it("degrades an orphaned tool result (compacted history) to plain user text", () => {
    const { msgs } = toAnthropicMessages([
      { role: "user", content: "continue" },
      { role: "tool", tool_call_id: "gone", name: "x", content: "stale result" },
    ]);
    expect(msgs[1]).toEqual({ role: "user", content: [{ type: "text", text: "[tool result] stale result" }] });
  });

  it("drops empty assistant turns (no text, no tool calls)", () => {
    const { msgs } = toAnthropicMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
      { role: "user", content: "still there?" },
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m: any) => m.role === "user")).toBe(true);
  });
});

describe("parseContent — Claude content blocks → text + tool calls", () => {
  it("extracts text and tool_use blocks", () => {
    const r = parseContent([
      { type: "text", text: "Let me check. " },
      { type: "tool_use", id: "toolu_1", name: "grep", input: { pattern: "TODO" } },
    ]);
    expect(r.text).toBe("Let me check. ");
    expect(r.toolCalls).toEqual([{ id: "toolu_1", name: "grep", arguments: { pattern: "TODO" } }]);
  });

  it("returns undefined toolCalls when there are none", () => {
    const r = parseContent([{ type: "text", text: "done" }]);
    expect(r.toolCalls).toBeUndefined();
  });
});

describe("AnthropicProvider construction", () => {
  it("identifies as the anthropic backend", () => {
    const p = new AnthropicProvider({
      model: "claude-opus-4-8",
      baseUrl: "https://api.anthropic.com",
      apiKey: "",
      authToken: "test-token",
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 8192,
    });
    expect(p.name).toBe("anthropic");
    expect(p.model).toBe("claude-opus-4-8");
  });
});
