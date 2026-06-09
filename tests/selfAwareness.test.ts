import { describe, it, expect } from "vitest";
import { replaceSelfAwareness } from "../src/cli/commands/chat";
import type { Message } from "../src/types";

const OLD =
  'SELF-AWARENESS — you are "Qwenodyssey", powered by the model "moonshotai/kimi-k2.6" ' +
  "served through a cloud model via OpenRouter (provider id: openrouter).";
const NEW =
  'SELF-AWARENESS — you are "Qwenodyssey", powered by the model "qwen2.5-coder:7b" ' +
  "served through a local Ollama model (provider id: ollama).";

describe("replaceSelfAwareness", () => {
  it("swaps the identity block so a switched model reports the new model", () => {
    const history: Message[] = [{ role: "system", content: `BASE RULES\n${OLD}` }];
    replaceSelfAwareness(history, NEW);
    expect(history[0].content).toContain("qwen2.5-coder:7b");
    expect(history[0].content).not.toContain("kimi-k2.6");
    expect(history[0].content).toContain("BASE RULES");
  });

  it("preserves the PROJECT summary appended after the identity block", () => {
    const history: Message[] = [
      { role: "system", content: `BASE RULES\n${OLD}\n\nPROJECT:\nfoo summary here` },
    ];
    replaceSelfAwareness(history, NEW);
    expect(history[0].content).toContain("qwen2.5-coder:7b");
    expect(history[0].content).not.toContain("kimi-k2.6");
    expect(history[0].content).toContain("\n\nPROJECT:\nfoo summary here");
  });

  it("preserves a /compact memo appended after the identity block", () => {
    const history: Message[] = [
      {
        role: "system",
        content: `BASE\n${OLD}\n\nPROJECT:\nsum\n\n[CONVERSATION SO FAR]\nmemo text`,
      },
    ];
    replaceSelfAwareness(history, NEW);
    expect(history[0].content).toContain("qwen2.5-coder:7b");
    expect(history[0].content).toContain("\n\nPROJECT:\nsum");
    expect(history[0].content).toContain("[CONVERSATION SO FAR]\nmemo text");
  });

  it("appends the block if the prompt somehow lacks one", () => {
    const history: Message[] = [{ role: "system", content: "BASE ONLY" }];
    replaceSelfAwareness(history, NEW);
    expect(history[0].content).toContain("BASE ONLY");
    expect(history[0].content).toContain("qwen2.5-coder:7b");
  });

  it("is a no-op when there is no system message", () => {
    const history: Message[] = [{ role: "user", content: "hi" }];
    replaceSelfAwareness(history, NEW);
    expect(history[0].content).toBe("hi");
  });
});
