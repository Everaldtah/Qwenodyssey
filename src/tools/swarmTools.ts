/**
 * The `agent_swarm` tool: lets the model spin up MANY frontier agents at once,
 * each on a different cloud model/API key, and either (ensemble) have them all
 * answer the same task then synthesize a best answer, or (divide) shard a list
 * of subtasks across them in parallel. Auto-built from the configured cloud keys.
 */
import type { Config } from "../core/config";
import type { Provider, Tool } from "../types";
import { Swarm, frontierWorkers, synthesize, type SwarmRun } from "../core/swarm";
import { createProvider, createNvidiaProvider, createOpenRouterProvider, createOllamaProvider } from "../providers";

// Ranked preference for the synthesizer/orchestrator: strong general+coding
// reasoners first. We pick the best one that's actually available (has a key),
// matched by substring against the worker roster.
const SYNTH_RANK = [
  "nemotron-3-ultra", "qwen3-coder-480b", "deepseek-v4", "kimi-k2",
  "llama-3.3-70b", "qwen3-coder",
];

/** The strongest available FRONTIER model to lead synthesis, or null if none. */
function bestFrontier(config: Config): Provider | null {
  const workers = frontierWorkers(config, { includeLocal: false });
  if (workers.length === 0) return null;
  for (const pref of SYNTH_RANK) {
    const w = workers.find((x) => x.model.toLowerCase().includes(pref));
    if (w) return w.provider;
  }
  return workers[0].provider; // any frontier beats a small local primary
}

/**
 * Resolve the synthesizer/judge provider. Default ("auto") ALWAYS uses the best
 * available frontier model so a small local primary (e.g. qwen2.5-coder:7b) never
 * does the final data synthesis — that's where swarm quality is won or lost.
 * "primary" forces the configured chat model; an explicit ref forces that model;
 * falls back to the primary only when no frontier worker is configured.
 */
function leadProvider(config: Config): Provider {
  const raw = (config.swarm.synthesizer || "auto").trim();
  const key = raw.toLowerCase();
  if (key === "primary") return createProvider(config);
  if (key && key !== "auto") {
    if (key.startsWith("nvidia:")) return createNvidiaProvider(config, raw.slice("nvidia:".length));
    if (key.startsWith("openrouter:")) return createOpenRouterProvider(config, raw.slice("openrouter:".length));
    return createOllamaProvider(config, raw);
  }
  return bestFrontier(config) ?? createProvider(config);
}

function formatRun(run: SwarmRun): string {
  const lines: string[] = [];
  const okCount = run.results.filter((r) => r.ok).length;
  lines.push(`🜂 agent swarm — ${run.mode} · ${run.results.length} worker(s), ${okCount} ok`);
  for (const r of run.results) {
    const head = `[${r.model}] ${(r.ms / 1000).toFixed(1)}s` + (r.ok ? "" : " — FAILED");
    lines.push("\n" + head);
    if (run.mode === "divide") lines.push(`  · subtask: ${r.task}`);
    lines.push(r.ok ? r.text : `  error: ${r.error}`);
  }
  if (run.synthesis) {
    lines.push(`\n=== synthesized answer${run.synthesizedBy ? ` (by ${run.synthesizedBy})` : ""} ===`);
    lines.push(run.synthesis);
  }
  return lines.join("\n");
}

export function createSwarmTools(config: Config): Tool[] {
  const agentSwarm: Tool = {
    name: "agent_swarm",
    description:
      "Run a swarm of frontier models in parallel for a complex task. Each worker is a different " +
      "cloud model on its own API key, all executing at the same time.",
    mutating: false,
    async run(args, ctx) {
      const task = String(args.task ?? "").trim();
      if (!task) return { ok: false, output: "agent_swarm: 'task' is required." };
      const mode = args.mode === "divide" ? "divide" : "ensemble";
      const doSynth = args.synthesize !== false; // default true

      const workers = frontierWorkers(config, {
        maxWorkers: config.swarm.max_workers,
        includeLocal: config.swarm.include_local,
        maxTokens: config.swarm.max_tokens,
      });
      if (workers.length === 0) {
        return {
          ok: false,
          output:
            "agent_swarm: no frontier workers available. Configure cloud models in model.fallback_models " +
            "(e.g. nvidia:… / openrouter:…) and set the matching API key(s).",
        };
      }

      const swarm = new Swarm(workers, { maxTokens: config.swarm.max_tokens });
      ctx.log({ tool: "agent_swarm", mode, workers: swarm.roster().map((r) => r.model) });

      let run: SwarmRun;
      if (mode === "divide") {
        const subtasks: string[] = Array.isArray(args.subtasks)
          ? args.subtasks.map((s: unknown) => String(s)).filter((s: string) => s.trim())
          : [];
        if (subtasks.length === 0) {
          return { ok: false, output: "agent_swarm: 'divide' mode needs a non-empty 'subtasks' array." };
        }
        run = await swarm.divide(subtasks, task);
      } else {
        run = await swarm.ensemble(task);
      }

      if (doSynth && run.results.some((r) => r.ok)) {
        const lead = leadProvider(config);
        run.synthesis = await synthesize(lead, task, run, config.swarm.max_tokens);
        run.synthesizedBy = lead.model;
      }

      const anyOk = run.results.some((r) => r.ok);
      return { ok: anyOk, output: formatRun(run) };
    },
  };
  return [agentSwarm];
}
