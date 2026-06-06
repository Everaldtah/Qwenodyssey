import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { defaultConfig } from "../src/core/config";
import { frontierWorkers } from "../src/core/swarm";

const SAVE = { ...process.env };

beforeEach(() => {
  delete process.env.NVIDIA_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
});
afterEach(() => {
  process.env = { ...SAVE };
});

describe("frontierWorkers", () => {
  it("includes a cloud ref only when its API key is present", () => {
    const cfg = defaultConfig();
    cfg.model.fallback_models = ["nvidia:foo/bar", "openrouter:baz/qux"];

    // No keys → no cloud workers.
    expect(frontierWorkers(cfg)).toHaveLength(0);

    // NVIDIA key only → just the nvidia worker.
    process.env.NVIDIA_API_KEY = "nvapi-test";
    const nv = frontierWorkers(cfg);
    expect(nv.map((w) => w.kind)).toEqual(["nvidia"]);

    // Both keys → both workers.
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const both = frontierWorkers(cfg);
    expect(both.map((w) => w.kind).sort()).toEqual(["nvidia", "openrouter"]);
  });

  it("adds the primary when it is a cloud model and dedupes against fallbacks", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const cfg = defaultConfig();
    cfg.model.provider = "openrouter";
    cfg.model.model = "moonshotai/kimi-k2.6";
    // Same model also listed as a fallback — must not appear twice.
    cfg.model.fallback_models = ["openrouter:moonshotai/kimi-k2.6"];
    const workers = frontierWorkers(cfg);
    expect(workers).toHaveLength(1);
    expect(workers[0].model).toBe("moonshotai/kimi-k2.6");
    expect(workers[0].label).toBe("kimi-k2.6");
  });

  it("excludes local refs unless includeLocal is set, and respects maxWorkers", () => {
    process.env.NVIDIA_API_KEY = "nvapi-test";
    const cfg = defaultConfig();
    cfg.model.fallback_models = ["nvidia:a/one", "nvidia:a/two", "qwen2.5:7b", "deepseek-r1:7b"];

    // Cloud-only by default.
    expect(frontierWorkers(cfg).map((w) => w.kind)).toEqual(["nvidia", "nvidia"]);

    // includeLocal pulls in the bare ollama tags too.
    const withLocal = frontierWorkers(cfg, { includeLocal: true });
    expect(withLocal.map((w) => w.kind)).toEqual(["nvidia", "nvidia", "ollama", "ollama"]);

    // maxWorkers caps the roster.
    expect(frontierWorkers(cfg, { includeLocal: true, maxWorkers: 2 })).toHaveLength(2);
  });
});
