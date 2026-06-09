import { describe, it, expect } from "vitest";
import { sanitizeAnswer } from "../src/cli/commands/chat";

describe("sanitizeAnswer", () => {
  it("removes a parroted <tool_response> block entirely", () => {
    const text =
      "<tool_response>\n[[qwenodyssey]] Qwenodyssey  (tags: project)\n  # Qwenodyssey ...\n</tool_response>";
    expect(sanitizeAnswer(text)).toBe("");
  });

  it("strips tool tags but keeps a real prose answer around them", () => {
    const text = "You are talking to qwen2.5-coder:7b. <tool_call>{\"name\":\"x\"}</tool_call>";
    expect(sanitizeAnswer(text)).toBe("You are talking to qwen2.5-coder:7b.");
  });

  it("removes stray unmatched tool tags", () => {
    expect(sanitizeAnswer("hi </tool_response>")).toBe("hi");
    expect(sanitizeAnswer("<tool_response>only opener\nresult")).toBe("only opener\nresult");
  });

  it("strips special <|...|> template tokens", () => {
    expect(sanitizeAnswer("the answer<|im_end|>")).toBe("the answer");
  });

  it("leaves a normal answer untouched", () => {
    expect(sanitizeAnswer("It is 3pm in the UK.")).toBe("It is 3pm in the UK.");
  });
});
