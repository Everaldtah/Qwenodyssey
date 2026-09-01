import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  modelProfile,
  resolveThinking,
  samplingFor,
  samplingForModel,
  isReasoningModel,
} from "../src/core/modelProfile";
import { tuneForModel } from "../src/providers";
import { OllamaProvider } from "../src/providers/ollama";
import { LMStudioProvider } from "../src/providers/lmstudio";
import { defaultConfig } from "../src/core/config";
import type { Config } from "../src/core/config";
import type { ProviderConfig } from "../src/providers/base";

/** Minimal provider config; individual tests override what they care about. */
function pcfg(model: string, extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    model,
    baseUrl: "http://localhost:11434",
    temperature: 0.2,
    topP: 0.9,
    maxTokens: 512,
    ...extra,
  };
}

describe("model family detection", () => {
  it("classifies Qwen 3.5 9B as a hybrid thinking model", () => {
    const p = modelProfile("qwen3.5:9b");
    expect(p.family).toBe("qwen3");
    expect(p.reasoning).toBe(true);
    expect(p.hybridThinking).toBe(true);
    // Coding/shell turns default to thinking OFF for speed + tool adherence.
    expect(p.thinkByDefault).toBe(false);
  });

  it("matches the Qwen 3 family across naming styles", () => {
    for (const tag of ["qwen3:8b", "qwen-3.5-9b", "Qwen3.5-Coder-9B-GGUF", "qwen_3.5:9b-q4"]) {
      expect(modelProfile(tag).hybridThinking).toBe(true);
    }
    expect(modelProfile("Qwen3.5-Coder-9B-GGUF").family).toBe("qwen3-coder");
  });

  it("keeps qwen2.x separate from qwen3 and stable under greedy decoding", () => {
    const p = modelProfile("qwen2.5-coder:7b");
    expect(p.family).toBe("qwen2.5-coder");
    expect(p.reasoning).toBe(false);
    expect(p.nonThinking.minTurnTemp).toBe(0);
  });

  it("preserves the reasoning classification of every model the old regex caught", () => {
    for (const m of [
      "deepseek-r1:7b",
      "qwq:32b",
      "moonshotai/kimi-k2.6",
      "nvidia/nemotron-nano-12b",
      "o1-mini",
      "o3",
      "some-thinking-model",
    ]) {
      expect(isReasoningModel(m)).toBe(true);
    }
    for (const m of ["qwen2.5:7b", "llama3.1:8b", "gemma3:12b", "mistral:7b"]) {
      expect(isReasoningModel(m)).toBe(false);
    }
  });

  it("gives gemma Google's published top_k", () => {
    expect(modelProfile("gemma3:12b").nonThinking.topK).toBe(64);
  });
});

describe("thinking policy", () => {
  it("auto turns Qwen3 thinking off but leaves pure reasoners deliberating", () => {
    expect(resolveThinking(modelProfile("qwen3.5:9b"), "auto")).toBe(false);
    expect(resolveThinking(modelProfile("deepseek-r1:7b"), "auto")).toBe(true);
  });

  it("always/never override the family default where the model supports it", () => {
    expect(resolveThinking(modelProfile("qwen3.5:9b"), "always")).toBe(true);
    expect(resolveThinking(modelProfile("qwen3.5:9b"), "never")).toBe(false);
    // R1 has no off switch — "never" must not produce an unsupported request.
    expect(resolveThinking(modelProfile("deepseek-r1:7b"), "never")).toBe(true);
  });

  it("reports undefined for models with no thinking mode at all", () => {
    expect(resolveThinking(modelProfile("qwen2.5-coder:7b"), "always")).toBeUndefined();
  });

  it("swaps in the sampling that matches the thinking state", () => {
    const p = modelProfile("qwen3.5:9b");
    expect(samplingFor(p, true)).toMatchObject({ temperature: 0.6, topP: 0.95, minTurnTemp: 0.6 });
    expect(samplingFor(p, false)).toMatchObject({
      temperature: 0.7,
      topP: 0.8,
      topK: 20,
      presencePenalty: 1.5,
      minTurnTemp: 0.3,
    });
    // Never greedy: Qwen3 loops at temperature 0.
    expect(samplingForModel("qwen3.5:9b", "auto").minTurnTemp).toBeGreaterThan(0);
  });
});

describe("auto-tuning provider config", () => {
  let config: Config;
  beforeEach(() => {
    config = defaultConfig();
  });

  it("fills the decoding knobs from the family profile", () => {
    const cfg = tuneForModel(config, "qwen3.5:9b", pcfg("qwen3.5:9b"));
    expect(cfg.topP).toBe(0.8);
    expect(cfg.topK).toBe(20);
    expect(cfg.presencePenalty).toBe(1.5);
    expect(cfg.repeatPenalty).toBe(1.05);
    expect(cfg.think).toBe("auto");
  });

  it("never overrides a value the user set explicitly", () => {
    config.model.top_p = 0.55;
    config.model.top_k = 7;
    const cfg = tuneForModel(config, "qwen3.5:9b", pcfg("qwen3.5:9b"));
    expect(cfg.topP).toBe(0.55);
    expect(cfg.topK).toBe(7);
    // Untouched knobs still get the profile's recommendation.
    expect(cfg.presencePenalty).toBe(1.5);
  });

  it("uses the literal config when auto_tune is off", () => {
    config.model.auto_tune = false;
    const cfg = tuneForModel(config, "qwen3.5:9b", pcfg("qwen3.5:9b"));
    expect(cfg.topP).toBe(0.9);
    expect(cfg.topK).toBe(0);
    expect(cfg.presencePenalty).toBe(0);
  });

  it("leaves models with no recommendations alone", () => {
    const cfg = tuneForModel(config, "llama3.1:8b", pcfg("llama3.1:8b"));
    expect(cfg.topK).toBe(0);
    expect(cfg.repeatPenalty).toBe(0);
  });
});

/** Capture the JSON body of the single fetch a provider call makes. */
function captureBody(): { get: () => any } {
  const ref: any = {};
  globalThis.fetch = vi.fn(async (_url: any, init: any) => {
    ref.body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ message: { content: "ok" }, choices: [{ message: { content: "ok" } }] }),
    } as any;
  }) as any;
  return { get: () => ref.body };
}

describe("Ollama request shaping", () => {
  let origFetch: any;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("disables thinking natively for a Qwen3 hybrid and passes the small-model knobs", async () => {
    const cap = captureBody();
    const p = new OllamaProvider(
      pcfg("qwen3.5:9b", { think: "auto", topK: 20, presencePenalty: 1.5, repeatPenalty: 1.05 })
    );
    await p.generate([{ role: "user", content: "hi" }]);
    const body = cap.get();
    expect(body.think).toBe(false);
    expect(body.options.top_k).toBe(20);
    expect(body.options.presence_penalty).toBe(1.5);
    expect(body.options.repeat_penalty).toBe(1.05);
  });

  it("requests thinking when the policy says always", async () => {
    const cap = captureBody();
    const p = new OllamaProvider(pcfg("qwen3.5:9b", { think: "always" }));
    await p.generate([{ role: "user", content: "hi" }]);
    expect(cap.get().think).toBe(true);
  });

  it("omits the think flag entirely for models without a thinking mode", async () => {
    const cap = captureBody();
    const p = new OllamaProvider(pcfg("qwen2.5-coder:7b", { think: "never" }));
    await p.generate([{ role: "user", content: "hi" }]);
    expect(cap.get()).not.toHaveProperty("think");
  });

  it("omits unset knobs so Ollama's own defaults apply", async () => {
    const cap = captureBody();
    const p = new OllamaProvider(pcfg("llama3.1:8b"));
    await p.generate([{ role: "user", content: "hi" }]);
    expect(cap.get().options).not.toHaveProperty("top_k");
    expect(cap.get().options).not.toHaveProperty("repeat_penalty");
  });
});

describe("OpenAI-compatible request shaping", () => {
  let origFetch: any;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("turns Qwen3.5 thinking off via chat_template_kwargs, never by editing the prompt", async () => {
    const cap = captureBody();
    const p = new LMStudioProvider(pcfg("qwen3.5-9b", { baseUrl: "http://localhost:1234", think: "never" }));
    await p.generate([
      { role: "system", content: "sys" },
      { role: "user", content: "list the files" },
    ]);
    const body = cap.get();
    const msgs = body.messages;
    expect(msgs[msgs.length - 1].content).toBe("list the files"); // no " /no_think" suffix
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("turns thinking on via chat_template_kwargs when asked to think", async () => {
    const cap = captureBody();
    const p = new LMStudioProvider(pcfg("qwen3.5-9b", { baseUrl: "http://localhost:1234", think: "always" }));
    await p.generate([{ role: "user", content: "list the files" }]);
    expect(cap.get().messages[0].content).toBe("list the files");
    expect(cap.get().chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("sends no chat_template_kwargs for models without a thinking mode", async () => {
    const cap = captureBody();
    const p = new LMStudioProvider(pcfg("qwen2.5-coder-7b", { baseUrl: "http://localhost:1234", think: "never" }));
    await p.generate([{ role: "user", content: "hi" }]);
    expect(cap.get()).not.toHaveProperty("chat_template_kwargs");
  });

  it("leaves non-hybrid models untouched", async () => {
    const cap = captureBody();
    const p = new LMStudioProvider(pcfg("qwen2.5-coder-7b", { baseUrl: "http://localhost:1234", think: "never" }));
    await p.generate([{ role: "user", content: "list the files" }]);
    expect(cap.get().messages[0].content).toBe("list the files");
  });

  it("forwards the sampling knobs under their OpenAI-compatible names", async () => {
    const cap = captureBody();
    const p = new LMStudioProvider(
      pcfg("qwen3.5-9b", { baseUrl: "http://localhost:1234", topK: 20, repeatPenalty: 1.05, presencePenalty: 1.5 })
    );
    await p.generate([{ role: "user", content: "hi" }]);
    const body = cap.get();
    expect(body.top_k).toBe(20);
    expect(body.repetition_penalty).toBe(1.05);
    expect(body.presence_penalty).toBe(1.5);
  });
});
