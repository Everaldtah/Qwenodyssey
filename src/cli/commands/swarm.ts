/**
 * `qwenodyssey swarm <task>` — run a complex task across a parallel swarm of
 * frontier models (one per configured cloud key) and print each answer plus a
 * synthesized best result. `--divide a "b" c` shards independent subtasks.
 */
import chalk from "chalk";
import { createSession, GlobalOpts } from "../session";
import { Swarm, frontierWorkers, synthesize } from "../../core/swarm";
import { createProvider } from "../../providers";

export interface SwarmOpts extends GlobalOpts {
  divide?: string[];
  synth?: boolean; // commander sets `synth: false` for --no-synth
  local?: boolean;
  list?: boolean; // show the roster and exit (no token spend)
}

export async function swarmCommand(task: string | undefined, opts: SwarmOpts): Promise<void> {
  const s = createSession(opts);

  if (!task && !opts.list) {
    console.log(chalk.red("A <task> is required (or use --list to just show the roster)."));
    process.exitCode = 1;
    return;
  }
  const taskText = task ?? "";

  const workers = frontierWorkers(s.config, {
    maxWorkers: s.config.swarm.max_workers,
    includeLocal: opts.local ?? s.config.swarm.include_local,
    maxTokens: s.config.swarm.max_tokens,
  });
  if (workers.length === 0) {
    console.log(
      chalk.red("No frontier workers available.") +
        chalk.gray(
          " Add cloud models to model.fallback_models (nvidia:… / openrouter:…) and set the API key(s)."
        )
    );
    process.exitCode = 1;
    return;
  }

  const swarm = new Swarm(workers, { maxTokens: s.config.swarm.max_tokens });
  console.log(
    chalk.bold(`\n🜂 Agent swarm — ${workers.length} model(s) in parallel:`) +
      "\n" +
      workers.map((w) => `  • ${chalk.cyan(w.model)} ${chalk.gray("(" + w.kind + ")")}`).join("\n") +
      "\n"
  );

  // Dry run: roster only, no requests.
  if (opts.list) {
    console.log(chalk.gray("(--list: roster only; no models were called.)"));
    return;
  }

  const divide = (opts.divide ?? []).map((d) => d.trim()).filter(Boolean);
  const started = Date.now();
  const run = divide.length ? await swarm.divide(divide, taskText) : await swarm.ensemble(taskText);

  for (const r of run.results) {
    const head = `${chalk.bold(r.model)} ${chalk.gray((r.ms / 1000).toFixed(1) + "s")}`;
    console.log(r.ok ? chalk.green("✓ ") + head : chalk.red("✗ ") + head);
    if (run.mode === "divide") console.log(chalk.gray("  subtask: " + r.task));
    console.log((r.ok ? r.text : chalk.red("  " + r.error)) + "\n");
  }

  if (opts.synth !== false && run.results.some((r) => r.ok)) {
    const lead = createProvider(s.config);
    console.log(chalk.gray(`Synthesizing best answer with ${lead.model}…\n`));
    const answer = await synthesize(lead, taskText, run, s.config.swarm.max_tokens);
    console.log(chalk.bold("═══ Synthesized answer ═══\n") + answer + "\n");
  }
  console.log(chalk.gray(`(swarm finished in ${((Date.now() - started) / 1000).toFixed(1)}s)`));
}
