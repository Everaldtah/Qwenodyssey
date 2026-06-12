/**
 * Coordinated agent swarm: instead of fanning the SAME task out to many models
 * (ensemble) or blindly round-robining pre-split subtasks (divide), this drives a
 * TEAM of frontier agents that share context and build on each other's work:
 *
 *   1. PLAN     — a lead model decomposes the task into dependency-aware subtasks
 *                 ({ id, title, detail, dependsOn[] }). Accurate splitting, by a
 *                 model that sees the whole task, not a naive shard.
 *   2. WAVES    — subtasks run in topological order. Every subtask whose deps are
 *                 already done runs in PARALLEL (one per worker); when a wave
 *                 finishes, its results land on a shared BLACKBOARD.
 *   3. CONTEXT  — each agent's prompt is injected with its dependencies' results
 *                 plus a roster of what teammates are doing, so later agents build
 *                 on earlier ones instead of working blind (real coordination).
 *   4. INTEGRATE— a lead model synthesizes the whole blackboard into one result.
 *
 * Roster policy: FRONTIER-FIRST. Workers (and the lead) are frontier cloud models
 * when any API key is configured; only when NO frontier model is available does the
 * roster fall back to local models, and finally to the configured primary — so the
 * swarm degrades gracefully on a keyless machine instead of failing outright.
 *
 * The coordinator is UI-agnostic: it emits events (plan/assign/delta/result/…) that
 * a TUI (or plain logger) subscribes to. No terminal code lives here.
 */
import { EventEmitter } from "events";
import type { Config } from "./config";
import type { Message, Provider } from "../types";
import {
  frontierWorkers,
  isReasoningModel,
  stripThinking,
  synthesize,
  type SwarmWorker,
  type WorkerResult,
  type SwarmRun,
} from "./swarm";
import { createProvider } from "../providers";

/* ───────────────────────── Swarm-agent system prompts ────────────────────────
 * These are deliberately NOT the full Qwenodyssey coding-agent harness prompt: a
 * swarm agent has no tools and no edit loop, it just produces a deliverable. Using
 * the harness prompt makes models emit <tool> call syntax as text and behave like
 * they're in a file-editing session — so the swarm uses focused, tool-free prompts.
 */
export const SWARM_PLANNER_SYSTEM =
  "You are the LEAD PLANNER of a team of expert AI agents working in parallel. You break a task into a " +
  "small set of concrete, separable subtasks that the team executes simultaneously and then integrate. " +
  "You do NOT execute the task or write any solution content yourself — you ONLY produce the plan as " +
  "strict JSON. You have no tools. Split along natural seams so subtasks can run in parallel, and use " +
  "dependsOn only when one subtask genuinely needs another's RESULT first.";

export const SWARM_AGENT_SYSTEM =
  "You are an expert AI agent completing ONE part of a larger task as a member of a coordinated team. " +
  "Produce the actual, finished deliverable for YOUR assigned subtask — write the real content (design, " +
  "code, prose, analysis), not a plan to do it later. You have NO tools and cannot run commands, browse, " +
  "or edit files: never emit tool-call syntax (no <tool> tags, no function calls) — output only the " +
  "finished result. When teammates' results are provided as shared context, build directly on them and " +
  "do not redo their work. Be concrete, correct, and self-contained.";

export const SWARM_SYNTH_SYSTEM =
  "You are the LEAD INTEGRATOR of a team of expert AI agents. You merge the team's completed subtask " +
  "results into ONE coherent, correct, complete deliverable that fulfills the overall task. Reconcile " +
  "overlaps and contradictions, keep each part's substance, and do not mention the team or the process. " +
  "You have no tools; output only the final integrated result.";

/* ───────────────────────── Plan / blackboard types ───────────────────────── */

export interface Subtask {
  id: string;
  title: string;
  detail: string;
  /** ids of subtasks whose RESULTS this one needs before it can run. */
  dependsOn: string[];
}

export type SubtaskStatus = "pending" | "running" | "done" | "failed";

/** Live state of one subtask on the shared blackboard. */
export interface BoardEntry extends Subtask {
  status: SubtaskStatus;
  /** Worker model that produced (or is producing) this result. */
  assignedTo?: string;
  result: string;
  error?: string;
  ms?: number;
}

/** Final result of one coordinated subtask (extends the swarm WorkerResult). */
export interface CoordinatedResult extends WorkerResult {
  id: string;
  title: string;
  dependsOn: string[];
}

/* ──────────────────────────── Event payloads ─────────────────────────────── */

export interface PlanEvent {
  task: string;
  subtasks: Subtask[];
  roster: { label: string; model: string; backend: string }[];
}
export interface WaveEvent {
  index: number;
  subtaskIds: string[];
}
export interface AssignEvent {
  pane: number;
  subtaskId: string;
  title: string;
  workerLabel: string;
  model: string;
}
export interface DeltaEvent {
  pane: number;
  subtaskId: string;
  delta: string;
}
export interface StatusEvent {
  pane: number;
  subtaskId: string;
  status: SubtaskStatus;
  ms?: number;
  error?: string;
}

/**
 * Typed EventEmitter facade. Events:
 *  - "plan"       PlanEvent     — decomposition finished, roster known
 *  - "wave"       WaveEvent     — a parallel batch is about to run
 *  - "assign"     AssignEvent   — a subtask was placed on a worker/pane
 *  - "delta"      DeltaEvent    — streamed token(s) from a worker
 *  - "status"     StatusEvent   — a subtask changed state (running/done/failed)
 *  - "result"     CoordinatedResult — a subtask finished (full text)
 *  - "synth"      { model }     — synthesis started
 *  - "synthDelta" { delta }     — streamed token(s) from the synthesizer
 *  - "done"       SwarmRun      — everything finished
 */
export class SwarmEvents extends EventEmitter {}

/* ──────────────────────────── Roster / lead ──────────────────────────────── */

/** Ranked preference for the lead (decomposer + synthesizer). */
const LEAD_RANK = [
  "nemotron-3-ultra", "qwen3-coder-480b", "deepseek-v4", "kimi-k2",
  "llama-3.3-70b", "qwen3-coder",
];

export interface RosterResult {
  workers: SwarmWorker[];
  /** True when we fell back to local models (no frontier key available). */
  local: boolean;
}

/**
 * Build the worker roster FRONTIER-FIRST. Frontier cloud workers when any key is
 * present; otherwise fall back to local refs from the fallback chain; otherwise a
 * single worker wrapping the configured primary provider (so a keyless, local-only
 * machine still runs the team, just on local models).
 */
export function buildRoster(config: Config, maxWorkers?: number): RosterResult {
  const cap = maxWorkers ?? config.swarm.max_workers;
  const frontier = frontierWorkers(config, {
    maxWorkers: cap,
    includeLocal: false,
    maxTokens: config.swarm.max_tokens,
  });
  if (frontier.length > 0) return { workers: frontier, local: false };

  // No frontier key — fall back to local refs in the fallback chain.
  const local = frontierWorkers(config, {
    maxWorkers: cap,
    includeLocal: true,
    maxTokens: config.swarm.max_tokens,
  });
  if (local.length > 0) return { workers: local, local: true };

  // Nothing configured — wrap the active primary as a lone worker.
  const primary = createProvider(config);
  return {
    workers: [
      {
        ref: primary.model,
        kind: "ollama",
        model: primary.model,
        label: primary.model.includes("/")
          ? primary.model.slice(primary.model.lastIndexOf("/") + 1)
          : primary.model,
        provider: primary,
      },
    ],
    local: true,
  };
}

/** Pick the lead (decomposer + synthesizer): strongest frontier worker, else the primary. */
export function pickLead(config: Config, workers: SwarmWorker[]): Provider {
  for (const pref of LEAD_RANK) {
    const w = workers.find((x) => x.model.toLowerCase().includes(pref));
    if (w) return w.provider;
  }
  return workers[0]?.provider ?? createProvider(config);
}

/* ──────────────────────────── Decomposition ──────────────────────────────── */

const PLAN_SCHEMA_HINT =
  'Return ONLY JSON of the form {"subtasks":[{"id":"slug","title":"…","detail":"…","dependsOn":["otherId"]}]}.';

/**
 * Ask the lead model to split the task into dependency-aware subtasks sized for the
 * team. Robustly parses the JSON; on any failure, degrades to a single subtask that
 * is the whole task (so the run still proceeds).
 */
export async function decompose(
  lead: Provider,
  task: string,
  workerCount: number,
  maxTokens: number,
  signal?: AbortSignal
): Promise<Subtask[]> {
  const target = Math.max(3, Math.min(workerCount * 2, 8));
  const prompt =
    `Decompose this task for a team of ${workerCount} expert agent(s) working in PARALLEL.\n` +
    `Aim for ${Math.min(3, target)}-${target} subtasks.\n\n` +
    `TASK:\n${task}\n\n` +
    `Rules:\n` +
    `- Split into the natural, separable parts of the task (e.g. distinct components, layers, files, or questions). If the task names several parts, make each its own subtask.\n` +
    `- Return AT LEAST 2 subtasks unless the task is genuinely atomic and cannot be divided.\n` +
    `- Each subtask is concrete, self-contained, and independently executable by one agent.\n` +
    `- Use "dependsOn" to list the ids of subtasks whose RESULTS a subtask needs first (foundational work has no deps). This is how the team shares context.\n` +
    `- Prefer breadth: subtasks that CAN run in parallel should have NO dependency between them.\n` +
    `- ids are short kebab-case slugs, unique.\n` +
    `- Do NOT solve the task here; only plan the split.\n\n` +
    PLAN_SCHEMA_HINT;

  const messages: Message[] = [
    { role: "system", content: SWARM_PLANNER_SYSTEM },
    { role: "user", content: prompt },
  ];
  try {
    const res = await lead.generate(messages, {
      temperature: 0.2,
      max_tokens: Math.min(maxTokens, 1200),
      json: true,
      signal,
    });
    const parsed = parsePlan(stripThinking(res.text));
    if (parsed.length) return parsed;
  } catch {
    /* fall through to single-subtask degrade */
  }
  return [{ id: "task", title: task.slice(0, 60), detail: task, dependsOn: [] }];
}

/** Extract a subtasks array from a model response that may wrap JSON in prose/fences. */
export function parsePlan(text: string): Subtask[] {
  const raw = extractJson(text);
  if (!raw) return [];
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr: any[] = Array.isArray(obj) ? obj : Array.isArray(obj?.subtasks) ? obj.subtasks : [];
  const seen = new Set<string>();
  const out: Subtask[] = [];
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i] ?? {};
    let id = String(s.id ?? s.slug ?? `s${i + 1}`).trim().toLowerCase().replace(/\s+/g, "-");
    if (!id || seen.has(id)) id = `s${i + 1}`;
    seen.add(id);
    const title = String(s.title ?? s.name ?? id).trim().slice(0, 80);
    const detail = String(s.detail ?? s.description ?? s.task ?? title).trim();
    const dependsOn = Array.isArray(s.dependsOn ?? s.deps)
      ? (s.dependsOn ?? s.deps).map((d: unknown) => String(d).trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean)
      : [];
    if (detail) out.push({ id, title, detail, dependsOn });
  }
  // Drop dangling deps (referencing ids that don't exist) so scheduling can't deadlock.
  const ids = new Set(out.map((s) => s.id));
  for (const s of out) s.dependsOn = s.dependsOn.filter((d) => ids.has(d) && d !== s.id);
  return out;
}

/** Find the first balanced {…} or […] block in a string. */
function extractJson(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/* ─────────────────────────── Shared blackboard ───────────────────────────── */

/** The shared store every agent reads context from and writes results to. */
export class Blackboard {
  readonly entries = new Map<string, BoardEntry>();

  constructor(subtasks: Subtask[]) {
    for (const s of subtasks) {
      this.entries.set(s.id, { ...s, status: "pending", result: "" });
    }
  }

  get(id: string): BoardEntry | undefined {
    return this.entries.get(id);
  }

  all(): BoardEntry[] {
    return [...this.entries.values()];
  }

  /** Subtasks whose deps are all resolved (done OR failed) and which are still pending. */
  ready(): BoardEntry[] {
    return this.all().filter(
      (e) =>
        e.status === "pending" &&
        e.dependsOn.every((d) => {
          const dep = this.entries.get(d);
          return !dep || dep.status === "done" || dep.status === "failed";
        })
    );
  }

  pending(): BoardEntry[] {
    return this.all().filter((e) => e.status === "pending");
  }

  /**
   * The context block injected into a worker's prompt: the results its dependencies
   * already produced (so it builds on them), plus a compact roster of every other
   * subtask's status (so it understands the whole plan and doesn't duplicate work).
   */
  digestFor(id: string, perDepChars = 1400): string {
    const me = this.entries.get(id);
    if (!me) return "";
    const parts: string[] = [];

    const deps = me.dependsOn.map((d) => this.entries.get(d)).filter((d): d is BoardEntry => !!d);
    const doneDeps = deps.filter((d) => d.status === "done" && d.result);
    if (doneDeps.length) {
      parts.push("RESULTS FROM YOUR DEPENDENCIES (build on these — do not redo them):");
      for (const d of doneDeps) {
        parts.push(`\n### [${d.id}] ${d.title}\n${truncate(d.result, perDepChars)}`);
      }
    }
    const failedDeps = deps.filter((d) => d.status === "failed");
    if (failedDeps.length) {
      parts.push(
        "\nNOTE — these dependencies FAILED, so their output is missing; compensate as best you can:\n" +
          failedDeps.map((d) => `- [${d.id}] ${d.title}`).join("\n")
      );
    }

    const others = this.all().filter((e) => e.id !== id);
    if (others.length) {
      parts.push(
        "\nTEAM PLAN (other agents' subtasks — for awareness; do NOT do their work):\n" +
          others
            .map((e) => `- [${e.id}] ${e.title} — ${e.status}`)
            .join("\n")
      );
    }
    return parts.join("\n");
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "\n…[truncated]";
}

/* ───────────────────────────── Coordinator ───────────────────────────────── */

export interface CoordinateOptions {
  maxTokens?: number;
  /** Skip the final synthesis step (just return the per-subtask results). */
  synthesize?: boolean;
  /** Pre-supplied subtasks (e.g. from --divide) — skips the decompose call. */
  subtasks?: Subtask[];
  signal?: AbortSignal;
}

export class CoordinatedSwarm {
  readonly events = new SwarmEvents();
  private workers: SwarmWorker[];
  private lead: Provider;
  private maxTokens: number;

  constructor(
    private config: Config,
    roster: SwarmWorker[],
    lead: Provider,
    opts: { maxTokens?: number } = {}
  ) {
    this.workers = roster;
    this.lead = lead;
    this.maxTokens = opts.maxTokens ?? config.swarm.max_tokens;
  }

  get size(): number {
    return this.workers.length;
  }

  roster(): { label: string; model: string; backend: string }[] {
    return this.workers.map((w) => ({ label: w.label, model: w.model, backend: w.kind }));
  }

  /** Run the full coordinated flow: plan → waves (with shared context) → synthesize. */
  async run(task: string, opts: CoordinateOptions = {}): Promise<SwarmRun> {
    const synth = opts.synthesize !== false;
    const subtasks =
      opts.subtasks && opts.subtasks.length
        ? opts.subtasks
        : await decompose(this.lead, task, this.workers.length, this.maxTokens, opts.signal);

    this.events.emit("plan", {
      task,
      subtasks,
      roster: this.roster(),
    } as PlanEvent);

    const board = new Blackboard(subtasks);
    const results: CoordinatedResult[] = [];

    let waveIndex = 0;
    let guard = subtasks.length + 2; // hard stop against any scheduling pathology
    while (board.pending().length > 0 && guard-- > 0) {
      let wave = board.ready();
      if (wave.length === 0) {
        // Dependency cycle or all-blocked: break it by forcing the pending subtask
        // with the fewest unmet deps to run anyway (its digest will note the gap).
        const stuck = board
          .pending()
          .sort((a, b) => unmet(board, a) - unmet(board, b))[0];
        if (!stuck) break;
        wave = [stuck];
      }

      this.events.emit("wave", { index: waveIndex, subtaskIds: wave.map((w) => w.id) } as WaveEvent);

      // Run the wave in batches no larger than the roster, so each active subtask
      // owns exactly one worker/pane at a time.
      for (let i = 0; i < wave.length; i += this.workers.length) {
        const batch = wave.slice(i, i + this.workers.length);
        await Promise.all(
          batch.map((entry, slot) => this.runSubtask(task, board, entry, slot, opts.signal, results))
        );
      }
      waveIndex++;
    }

    const run: SwarmRun = { mode: "divide", results };

    if (synth && results.some((r) => r.ok)) {
      this.events.emit("synth", { model: this.lead.model });
      const synthRun: SwarmRun = { mode: "divide", results };
      run.synthesis = await this.synthesizeStreamed(task, synthRun, opts.signal);
      run.synthesizedBy = this.lead.model;
    }

    this.events.emit("done", run);
    return run;
  }

  /** Execute one subtask on a worker, streaming its tokens and writing to the board. */
  private async runSubtask(
    task: string,
    board: Blackboard,
    entry: BoardEntry,
    pane: number,
    signal: AbortSignal | undefined,
    sink: CoordinatedResult[]
  ): Promise<void> {
    const worker = this.workers[pane % this.workers.length];
    entry.status = "running";
    entry.assignedTo = worker.model;

    this.events.emit("assign", {
      pane,
      subtaskId: entry.id,
      title: entry.title,
      workerLabel: worker.label,
      model: worker.model,
    } as AssignEvent);
    this.events.emit("status", { pane, subtaskId: entry.id, status: "running" } as StatusEvent);

    const context = board.digestFor(entry.id);
    const solo = board.all().length <= 1;
    const prompt =
      `OVERALL TASK:\n${task}\n\n` +
      (solo
        ? ``
        : `YOU ARE ONE AGENT IN A COORDINATED TEAM. Focus ONLY on your assigned subtask below; teammates handle the rest.\n\n`) +
      `YOUR SUBTASK [${entry.id}] ${entry.title}:\n${entry.detail}\n\n` +
      (context ? `--- SHARED CONTEXT FROM YOUR TEAM ---\n${context}\n\n` : "") +
      `Produce a focused, complete, final result for YOUR subtask. Reference teammates' results where relevant; don't repeat their work.`;

    const messages: Message[] = [
      { role: "system", content: SWARM_AGENT_SYSTEM },
      { role: "user", content: prompt },
    ];

    const start = Date.now();
    let text = "";
    try {
      const res = await worker.provider.stream(
        messages,
        (delta) => {
          text += delta;
          this.events.emit("delta", { pane, subtaskId: entry.id, delta } as DeltaEvent);
        },
        {
          temperature: isReasoningModel(worker.model) ? 0.6 : 0.3,
          max_tokens: this.maxTokens,
          signal,
        }
      );
      const clean = stripThinking(res.text || text).trim();
      entry.status = "done";
      entry.result = clean;
      entry.ms = Date.now() - start;
      const result: CoordinatedResult = {
        id: entry.id,
        title: entry.title,
        dependsOn: entry.dependsOn,
        label: worker.label,
        model: worker.model,
        backend: worker.kind,
        task: entry.detail,
        ok: true,
        text: clean,
        ms: entry.ms,
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens,
      };
      sink.push(result);
      this.events.emit("status", {
        pane,
        subtaskId: entry.id,
        status: "done",
        ms: entry.ms,
      } as StatusEvent);
      this.events.emit("result", result);
    } catch (err) {
      entry.status = "failed";
      entry.error = (err as Error).message;
      entry.ms = Date.now() - start;
      const result: CoordinatedResult = {
        id: entry.id,
        title: entry.title,
        dependsOn: entry.dependsOn,
        label: worker.label,
        model: worker.model,
        backend: worker.kind,
        task: entry.detail,
        ok: false,
        text: "",
        error: entry.error,
        ms: entry.ms,
      };
      sink.push(result);
      this.events.emit("status", {
        pane,
        subtaskId: entry.id,
        status: "failed",
        ms: entry.ms,
        error: entry.error,
      } as StatusEvent);
      this.events.emit("result", result);
    }
  }

  /** Stream the synthesizer so the TUI/log can show the final answer forming. */
  private async synthesizeStreamed(
    task: string,
    run: SwarmRun,
    signal?: AbortSignal
  ): Promise<string> {
    const ok = run.results.filter((r) => r.ok && r.text);
    if (ok.length === 0) return "All swarm agents failed; no answer to synthesize.";
    if (ok.length === 1) return ok[0].text;

    const blocks = ok
      .map((r) => `### [${(r as CoordinatedResult).id ?? "?"}] ${(r as CoordinatedResult).title ?? r.model}\n${r.text}`)
      .join("\n\n");
    const messages: Message[] = [
      { role: "system", content: SWARM_SYNTH_SYSTEM },
      {
        role: "user",
        content:
          `OVERALL TASK:\n${task}\n\n` +
          `A team of agents completed the subtasks below, sharing context as they went. Integrate their ` +
          `outputs into ONE coherent, correct, complete result that fulfills the overall task. Keep each ` +
          `subtask's substance, reconcile overlaps, and resolve any contradictions. Do not mention the team.\n\n` +
          `${blocks}\n\n--- Write the single integrated final result below. ---`,
      },
    ];
    try {
      const res = await this.lead.stream(
        messages,
        (delta) => this.events.emit("synthDelta", { delta }),
        { temperature: 0.3, max_tokens: this.maxTokens, signal }
      );
      return stripThinking(res.text).trim() || blocks;
    } catch {
      // Non-streaming fallback to the shared helper.
      try {
        return await synthesize(this.lead, task, run, this.maxTokens);
      } catch {
        return blocks;
      }
    }
  }
}

/** Count a subtask's dependencies that aren't yet resolved. */
function unmet(board: Blackboard, e: BoardEntry): number {
  return e.dependsOn.filter((d) => {
    const dep = board.get(d);
    return dep && dep.status !== "done" && dep.status !== "failed";
  }).length;
}

/**
 * Convenience: build the roster + lead from config and return a ready coordinator.
 * Returns null when there is genuinely nothing to run with.
 */
export function createCoordinatedSwarm(
  config: Config,
  maxWorkers?: number
): { swarm: CoordinatedSwarm; local: boolean } | null {
  const { workers, local } = buildRoster(config, maxWorkers);
  if (workers.length === 0) return null;
  const lead = pickLead(config, workers);
  const swarm = new CoordinatedSwarm(config, workers, lead, { maxTokens: config.swarm.max_tokens });
  return { swarm, local };
}
