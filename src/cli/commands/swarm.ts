/**
 * `qwenodyssey swarm <task>` — run a complex task across a COORDINATED team of
 * frontier agents. A lead model splits the task into dependency-aware subtasks; the
 * agents share a blackboard (each sees its dependencies' results) and run in
 * parallel waves, streaming live into a split-pane TUI (one terminal per agent).
 * Finally a lead model integrates the board into one answer.
 *
 *   --plain      classic mode (ensemble, or --divide shards) with no coordination
 *   --no-live    coordinated, but log progress as plain lines (no TUI)
 *   --divide …   supply the subtasks yourself (skips auto-decomposition)
 *   --list       show the roster and exit (no models are called)
 *
 * Roster is FRONTIER-FIRST: cloud models when keys exist, else local, else primary.
 */
import chalk from "chalk";
import { createSession, GlobalOpts } from "../session";
import { Swarm, frontierWorkers, synthesize, type SwarmWorker } from "../../core/swarm";
import {
  createCoordinatedSwarm,
  CoordinatedSwarm,
  type Subtask,
  type PlanEvent,
  type AssignEvent,
  type StatusEvent,
  type CoordinatedResult,
} from "../../core/swarmCoordinator";
import { SwarmTui } from "../swarmTui";
import { createProvider } from "../../providers";
import type { SwarmRun } from "../../core/swarm";
import type { Provider } from "../../types";

export interface SwarmOpts extends GlobalOpts {
  divide?: string[];
  synth?: boolean; // commander sets `synth: false` for --no-synth
  local?: boolean;
  list?: boolean; // show the roster and exit (no token spend)
  live?: boolean; // commander sets `live: false` for --no-live
  plain?: boolean; // classic uncoordinated ensemble/divide
  demo?: boolean; // synthetic workers, no network — verify the TUI instantly
  exec?: string; // off|auto|bare|daytona — where agents may run commands
}

export async function swarmCommand(task: string | undefined, opts: SwarmOpts): Promise<void> {
  const s = createSession(opts);

  if (!task && !opts.list && !opts.demo) {
    console.log(chalk.red("A <task> is required (or use --list to just show the roster)."));
    process.exitCode = 1;
    return;
  }
  const taskText = task ?? "";

  // ── demo: synthetic streaming workers, zero network — verifies the TUI ──
  if (opts.demo) {
    return demoSwarm(s, opts);
  }

  // ── classic (uncoordinated) path: --plain ──
  if (opts.plain) {
    return plainSwarm(s, taskText, opts);
  }

  // ── coordinated path (default) ──
  const built = createCoordinatedSwarm(s.config);
  if (!built) {
    console.log(
      chalk.red("No swarm workers available.") +
        chalk.gray(
          " Add cloud models to model.fallback_models (nvidia:… / openrouter:…) and set the API key(s), or configure a local primary."
        )
    );
    process.exitCode = 1;
    return;
  }
  const { swarm, local } = built;
  const note = local ? "(local fallback — no frontier key configured)" : undefined;

  const roster = swarm.roster();
  console.log(
    chalk.bold(`\n🜂 Coordinated swarm — ${roster.length} agent(s):`) +
      "\n" +
      roster.map((w) => `  • ${chalk.cyan(w.model)} ${chalk.gray("(" + w.backend + ")")}`).join("\n") +
      (note ? "\n  " + chalk.yellow(note) : "") +
      "\n"
  );

  if (opts.list) {
    console.log(chalk.gray("(--list: roster only; no models were called.)"));
    return;
  }

  // Explicit --divide subtasks skip auto-decomposition (still coordinated/streamed).
  const presupplied: Subtask[] | undefined =
    opts.divide && opts.divide.length
      ? opts.divide
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d, i) => ({ id: `s${i + 1}`, title: d.slice(0, 60), detail: d, dependsOn: [] }))
      : undefined;

  // Where agents may run commands: CLI flag overrides config ([swarm] exec).
  const execMode = (opts.exec ?? s.config.swarm.exec) as import("../../core/agentExec").ExecMode;
  const bareOpts = {
    cwd: process.cwd(),
    allowCommands: s.config.tools.allow_commands,
    denyCommands: s.config.tools.deny_commands,
    defaultTimeoutMs: s.config.swarm.exec_timeout_s * 1000,
  };

  const useTui = opts.live !== false && s.config.swarm.live && SwarmTui.supported();
  const started = Date.now();

  // Ctrl-C aborts in-flight model calls and restores the screen cleanly instead of
  // leaving the terminal stuck in the alternate-screen / hidden-cursor state.
  const ac = new AbortController();
  let aborted = false;

  let run: SwarmRun;
  if (useTui) {
    const tui = new SwarmTui(swarm.events, {
      task: taskText,
      panes: roster.length,
      note,
      roster: roster.map((r) => ({ label: r.label, model: r.model, backend: r.backend })),
      cwd: process.cwd(),
    });
    const onSigint = () => {
      aborted = true;
      ac.abort();
      tui.stop();
    };
    process.once("SIGINT", onSigint);
    tui.start();
    try {
      run = await swarm.run(taskText, {
        synthesize: opts.synth !== false,
        subtasks: presupplied,
        signal: ac.signal,
        execMode,
        bareOpts,
      });
    } finally {
      tui.stop();
      process.removeListener("SIGINT", onSigint);
    }
  } else {
    const onSigint = () => {
      aborted = true;
      ac.abort();
    };
    process.once("SIGINT", onSigint);
    attachPlainLogger(swarm.events);
    try {
      run = await swarm.run(taskText, {
        synthesize: opts.synth !== false,
        subtasks: presupplied,
        signal: ac.signal,
        execMode,
        bareOpts,
      });
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  }

  if (aborted) {
    console.log(chalk.yellow("\n(swarm aborted by Ctrl-C)"));
    process.exitCode = 130;
  }

  // Durable summary (printed to normal scrollback after the TUI restores the screen).
  printSummary(run, Date.now() - started);
}

/** Plain line logger for --no-live / non-TTY: announce plan + each subtask result. */
function attachPlainLogger(events: import("../../core/swarmCoordinator").SwarmEvents): void {
  events.on("plan", (e: PlanEvent) => {
    const by = e.plannedBy && e.plannedBy !== "(supplied)" ? chalk.gray(` (planned by ${e.plannedBy})`) : "";
    console.log(chalk.bold(`\nPlan — ${e.subtasks.length} subtask(s)`) + by + ":");
    for (const st of e.subtasks) {
      const deps = st.dependsOn.length ? chalk.gray(` ← ${st.dependsOn.join(", ")}`) : "";
      console.log(`  ${chalk.cyan("[" + st.id + "]")} ${st.title}${deps}`);
    }
    if (e.exec) console.log(chalk.gray(`  complexity: ${e.complexity ?? "?"} · exec: ${e.exec}`));
    if (e.note) console.log(chalk.yellow(`  ⚠ ${e.note}`));
    console.log("");
  });
  events.on("execCmd", (e: { subtaskId: string; command: string; ok: boolean }) => {
    console.log(chalk.gray(`  $ [${e.subtaskId}] ${e.command.slice(0, 100)}${e.ok ? "" : "  (failed)"}`));
  });
  events.on("assign", (e: AssignEvent) =>
    console.log(chalk.gray(`▸ ${e.model} → [${e.subtaskId}] ${e.title}`))
  );
  events.on("status", (e: StatusEvent) => {
    if (e.status === "done") console.log(chalk.green(`  ✓ [${e.subtaskId}] (${((e.ms ?? 0) / 1000).toFixed(1)}s)`));
    if (e.status === "failed") console.log(chalk.red(`  ✗ [${e.subtaskId}] ${e.error ?? ""}`));
  });
  events.on("synth", (e: { model: string }) => console.log(chalk.gray(`\nSynthesizing with ${e.model}…`)));
}

function printSummary(run: SwarmRun, elapsedMs: number): void {
  console.log("");
  for (const r of run.results as CoordinatedResult[]) {
    const head = `${chalk.bold("[" + (r.id ?? "?") + "] " + (r.title ?? r.model))} ${chalk.gray(r.model + " · " + (r.ms / 1000).toFixed(1) + "s")}`;
    console.log(r.ok ? chalk.green("✓ ") + head : chalk.red("✗ ") + head);
    console.log((r.ok ? r.text : chalk.red("  " + r.error)) + "\n");
  }
  if (run.synthesis) {
    console.log(
      chalk.bold(`═══ Integrated answer${run.synthesizedBy ? ` (by ${run.synthesizedBy})` : ""} ═══\n`) +
        run.synthesis +
        "\n"
    );
  }
  console.log(chalk.gray(`(swarm finished in ${(elapsedMs / 1000).toFixed(1)}s)`));
}

/* ── demo mode: fake agents streaming through the REAL coordinator + TUI ── */

const DEMO_TEXTS = [
  "Surveying the landscape: enumerating the key requirements, constraints, and edge cases this design must satisfy before anything is built. ",
  "Drafting the core architecture: components, interfaces between them, and the data that flows across each boundary, with failure modes called out. ",
  "Writing concrete examples: a quick-start snippet, a typical production configuration, and one advanced scenario exercising the tricky paths. ",
  "Integrating the team's results into one coherent deliverable, reconciling overlaps and making the terminology consistent throughout. ",
];

function demoProvider(model: string, text: string): Provider {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    name: "demo",
    model,
    async generate() {
      return { text, model };
    },
    async stream(_messages, onChunk, options) {
      // Word-by-word so the panes visibly stream, ~8s per agent.
      for (const word of text.repeat(3).split(/(?<=\s)/)) {
        if (options?.signal?.aborted) throw new Error("__interrupted__");
        await sleep(55);
        onChunk(word);
      }
      return { text: text.repeat(3), model };
    },
    countTokens: (t) => Math.ceil(t.length / 4),
    async healthCheck() {
      return { ok: true };
    },
  };
}

/** No-network rehearsal: 4 fake agents run the real plan→waves→synthesis flow. */
async function demoSwarm(s: ReturnType<typeof createSession>, opts: SwarmOpts): Promise<void> {
  const models = ["demo/kimi", "demo/nemotron", "demo/llama", "demo/deepseek"];
  const workers: SwarmWorker[] = models.map((m, i) => ({
    ref: m,
    kind: "ollama",
    model: m,
    label: m.slice(5),
    provider: demoProvider(m, DEMO_TEXTS[i % DEMO_TEXTS.length]),
  }));
  const lead = demoProvider("demo/lead", DEMO_TEXTS[3]);
  const swarm = new CoordinatedSwarm(s.config, workers, lead, { maxTokens: 400 });

  const subtasks: Subtask[] = [
    { id: "requirements", title: "Gather requirements", detail: "demo", dependsOn: [] },
    { id: "architecture", title: "Draft architecture", detail: "demo", dependsOn: [] },
    { id: "examples", title: "Write examples", detail: "demo", dependsOn: [] },
    { id: "integrate", title: "Integrate everything", detail: "demo", dependsOn: ["requirements", "architecture", "examples"] },
  ];

  const task = "DEMO — four fake agents rehearsing the coordinated swarm (no models called)";
  console.log(chalk.bold("\n🜂 Swarm demo — no models are called; this rehearses the live TUI.\n"));

  if (opts.live !== false && SwarmTui.supported()) {
    const tui = new SwarmTui(swarm.events, {
      task,
      panes: workers.length,
      note: "demo mode (no tokens spent)",
      roster: workers.map((w) => ({ label: w.label, model: w.model, backend: w.kind })),
      cwd: process.cwd(),
    });
    tui.start();
    try {
      await swarm.run(task, { synthesize: true, subtasks });
    } finally {
      tui.stop();
    }
    console.log(
      chalk.green("✓ demo finished.") +
        chalk.gray(
          " You should have seen: 3 panes streaming in parallel (wave 1), then 'integrate' streaming in wave 2, then a synthesis line."
        )
    );
  } else {
    attachPlainLogger(swarm.events);
    await swarm.run(task, { synthesize: true, subtasks });
    console.log(
      chalk.yellow("\n(no TTY here — ran with the plain logger; run from a real terminal to see the panes)")
    );
  }
}

/* ── classic uncoordinated swarm (--plain): preserved from the original command ── */
async function plainSwarm(
  s: ReturnType<typeof createSession>,
  taskText: string,
  opts: SwarmOpts
): Promise<void> {
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
    chalk.bold(`\n🜂 Agent swarm (plain) — ${workers.length} model(s) in parallel:`) +
      "\n" +
      workers.map((w) => `  • ${chalk.cyan(w.model)} ${chalk.gray("(" + w.kind + ")")}`).join("\n") +
      "\n"
  );

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
