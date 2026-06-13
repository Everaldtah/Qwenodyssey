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
import type { Message, Provider, ToolSpec, ToolCall } from "../types";
import {
  chooseExecutor,
  type AgentExecutor,
  type ExecMode,
  type PlanComplexity,
  type BareExecutorOptions,
} from "./agentExec";
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
 *
 * The rigor below ADAPTS the orchestration doctrine from openclaw's AGENTS.md
 * (github.com/openclaw/openclaw) — evidence-driven, exhaustive, best-fix work;
 * complete production-grade output; verify-when-feasible; no memory-only guesses —
 * to push small models toward more accurate, fleshed-out code. (Design ideas only;
 * no source copied.)
 */

/** Shared standards every swarm agent is held to (openclaw-AGENTS.md-inspired). */
const SWARM_STANDARDS =
  "Standards:\n" +
  "- Deliver COMPLETE, production-grade work: full implementations with edge cases, error handling, input " +
  "validation, and sensible defaults. NO stubs, NO TODOs, NO placeholders, NO '...'.\n" +
  "- Be the BEST solution, not merely a plausible one: choose the approach a senior engineer would defend.\n" +
  "- Ground every decision in the task and the shared context, not assumptions or memory. If a fact is " +
  "genuinely unknown, state the assumption explicitly instead of guessing silently.\n" +
  "- Code must be runnable as written: correct imports, types, names, and signatures consistent with teammates' work.\n" +
  "- Prefer correctness and completeness over brevity; include what's needed to actually use it.";

export const SWARM_PLANNER_SYSTEM =
  "You are the LEAD PLANNER of a team of expert AI engineers working in parallel. Break the task into a " +
  "small set of concrete, separable subtasks whose UNION fully covers the task with NO gaps, then they " +
  "integrate. Each subtask must name a clear, verifiable deliverable. Split along natural seams so subtasks " +
  "run in parallel; use dependsOn only when one genuinely needs another's RESULT first; include an " +
  "integration (and, for buildable work, a verification/test) subtask. You do NOT solve the task — you ONLY " +
  "produce the plan as strict JSON. You have no tools.";

export const SWARM_AGENT_SYSTEM =
  "You are an expert AI engineer completing ONE part of a larger task as a member of a coordinated team. " +
  "Produce the actual, finished deliverable for YOUR assigned subtask — the real content (design, code, " +
  "prose, analysis), not a plan to do it later. You have NO tools and cannot run commands, browse, or edit " +
  "files: never emit tool-call syntax (no <tool> tags, no function calls) — output only the finished result. " +
  "When teammates' results are provided as shared context, build directly on them and do not redo their work.\n\n" +
  SWARM_STANDARDS;

/** Variant used when an execution backend is attached to the run. */
export function swarmAgentExecSystem(execLabel: string): string {
  return (
    "You are an expert AI engineer completing ONE part of a larger task as a member of a coordinated team. " +
    "Produce the actual, finished deliverable for YOUR assigned subtask — real content, not a plan.\n" +
    `You have exactly ONE tool: run_shell, which executes a shell command on ${execLabel}. Use it to create ` +
    "the real files, install dependencies, build, and — critically — ACTUALLY RUN and VERIFY your work " +
    "(execute the program, run the tests) before claiming success. Only state 'done' after verification passes. " +
    "Workspace is SHARED with teammates: their files are already present; place yours alongside and don't clobber " +
    "theirs. Keep commands non-interactive and non-destructive. Build on teammates' context; never redo their work. " +
    "When done, answer with the final deliverable text and the paths of the files you created/verified.\n\n" +
    SWARM_STANDARDS
  );
}

export const SWARM_SYNTH_SYSTEM =
  "You are the LEAD INTEGRATOR of a team of expert AI engineers. Merge the team's completed subtask results " +
  "into ONE coherent, correct, COMPLETE deliverable that fully fulfills the overall task. Reconcile overlaps " +
  "and contradictions, close any gaps between parts, and keep each part's substance. The result must be " +
  "production-grade with no stubs, TODOs, or placeholders. Do not mention the team or the process. You have " +
  "no tools; output only the final integrated result.";

/* ───────────────────────── Plan / blackboard types ───────────────────────── */

export interface Subtask {
  id: string;
  title: string;
  detail: string;
  /** ids of subtasks whose RESULTS this one needs before it can run. */
  dependsOn: string[];
}

export type SubtaskStatus = "pending" | "running" | "done" | "failed" | "stopped";

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
  /** Which model produced the plan ("(supplied)" for --divide, "(fallback)" when planning failed). */
  plannedBy?: string;
  /** Human-readable diagnostic when planning degraded (e.g. a lead timed out). */
  note?: string;
  /** Planner's complexity judgment for the project. */
  complexity?: PlanComplexity;
  /** Execution backend label when agents can run commands ("bare metal" / "daytona sandbox"). */
  exec?: string;
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
export interface PreflightResult {
  pane: number;
  label: string;
  model: string;
  backend: string;
  ok: boolean;
  detail?: string;
  ms: number;
}

/**
 * Typed EventEmitter facade. Events:
 *  - "preflightStart" { count }      — about to health-check the roster's keys
 *  - "preflight"  PreflightResult    — one worker's key/endpoint checked (ok/broken)
 *  - "preflightDone" { ok, broken }  — health-check finished
 *  - "planner"    { model }     — a decompose attempt started on this model
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

/**
 * Health-check every worker's provider in PARALLEL before the run, so a broken or
 * expired API key / dead endpoint is caught up front instead of failing a subtask
 * mid-flight. Each provider's healthCheck() hits its /models (or equivalent) WITH
 * the configured key, so a 401/403 or network error surfaces here.
 */
export async function preflightWorkers(
  workers: SwarmWorker[],
  onResult?: (r: PreflightResult) => void,
  timeoutMs = 15000
): Promise<PreflightResult[]> {
  return Promise.all(
    workers.map(async (w, pane): Promise<PreflightResult> => {
      const start = Date.now();
      const base = { pane, label: w.label, model: w.model, backend: w.kind };
      try {
        const timeout = new Promise<{ ok: boolean; detail?: string }>((_, rej) =>
          setTimeout(() => rej(new Error(`health check timed out after ${timeoutMs}ms`)), timeoutMs)
        );
        const h = await Promise.race([w.provider.healthCheck(), timeout]);
        const r: PreflightResult = { ...base, ok: h.ok, detail: h.detail, ms: Date.now() - start };
        onResult?.(r);
        return r;
      } catch (err) {
        const r: PreflightResult = { ...base, ok: false, detail: (err as Error).message, ms: Date.now() - start };
        onResult?.(r);
        return r;
      }
    })
  );
}

/* ──────────────────────────── Decomposition ──────────────────────────────── */

const PLAN_SCHEMA_HINT =
  'Return ONLY JSON of the form {"complexity":"simple"|"complex","subtasks":[{"id":"slug","title":"…","detail":"…","dependsOn":["otherId"]}]}. ' +
  '"complex" = the work needs real project execution (installing dependencies, building/running a multi-file ' +
  'codebase, long-running processes or services); "simple" = analysis, writing, design, or single-file code.';

export interface DecomposeResult {
  subtasks: Subtask[];
  plannedBy: string;
  note?: string;
  complexity: PlanComplexity;
}

/** Read the planner's complexity judgment out of its JSON (defaults to "simple"). */
export function parseComplexity(text: string): PlanComplexity {
  const m = text.match(/"complexity"\s*:\s*"(simple|complex)"/i);
  return m && m[1].toLowerCase() === "complex" ? "complex" : "simple";
}

/**
 * Ask a lead model to split the task into dependency-aware subtasks sized for the
 * team. RESILIENT: tries each candidate planner in order (a slow/timing-out lead —
 * e.g. nemotron-3-ultra at 90s — must not silently collapse the whole run into one
 * subtask). Only when EVERY candidate fails does it degrade to a single subtask
 * that is the whole task, with a note saying so.
 */
export async function decomposeWith(
  candidates: Provider[],
  task: string,
  workerCount: number,
  maxTokens: number,
  signal?: AbortSignal,
  onAttempt?: (model: string) => void
): Promise<DecomposeResult> {
  const errors: string[] = [];
  for (const lead of candidates) {
    if (signal?.aborted) break;
    onAttempt?.(lead.model);
    try {
      const { subtasks, complexity } = await decomposeOnce(lead, task, workerCount, maxTokens, signal);
      if (subtasks.length) {
        return {
          subtasks,
          complexity,
          plannedBy: lead.model,
          note: errors.length ? `planner fell back to ${lead.model} (${errors.join("; ")})` : undefined,
        };
      }
      errors.push(`${lead.model}: returned no parseable plan`);
    } catch (err) {
      errors.push(`${lead.model}: ${(err as Error).message}`);
    }
  }
  return {
    subtasks: [{ id: "task", title: task.slice(0, 60), detail: task, dependsOn: [] }],
    plannedBy: "(fallback)",
    complexity: "simple",
    note: `decomposition failed — running as a single task (${errors.join("; ")})`,
  };
}

/** Back-compat single-lead wrapper (kept for existing callers/tests). */
export async function decompose(
  lead: Provider,
  task: string,
  workerCount: number,
  maxTokens: number,
  signal?: AbortSignal
): Promise<Subtask[]> {
  return (await decomposeWith([lead], task, workerCount, maxTokens, signal)).subtasks;
}

async function decomposeOnce(
  lead: Provider,
  task: string,
  workerCount: number,
  maxTokens: number,
  signal?: AbortSignal
): Promise<{ subtasks: Subtask[]; complexity: PlanComplexity }> {
  const target = Math.max(3, Math.min(workerCount * 2, 8));
  const prompt =
    `Decompose this task for a team of ${workerCount} expert agent(s) working in PARALLEL.\n` +
    `Aim for ${Math.min(3, target)}-${target} subtasks.\n\n` +
    `TASK:\n${task}\n\n` +
    `Rules:\n` +
    `- Split into the natural, separable parts of the task (e.g. distinct components, layers, files, or questions). If the task names several parts, make each its own subtask.\n` +
    `- The subtasks' UNION must FULLY cover the task with no gaps. Include an integration subtask, and a verification/test subtask for buildable work.\n` +
    `- Each subtask's "detail" names a CONCRETE, VERIFIABLE deliverable (what file/output proves it's done).\n` +
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
  const res = await lead.generate(messages, {
    temperature: 0.2,
    max_tokens: Math.min(maxTokens, 1200),
    json: true,
    signal,
  });
  const clean = stripThinking(res.text);
  return { subtasks: parsePlan(clean), complexity: parseComplexity(clean) };
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

/* ───────────── model-output cleanup / non-standard (Kimi) tool calls ────────── */

/**
 * Some hosted models — notably Kimi K2.x on NVIDIA NIM — emit tool calls as SPECIAL
 * TOKENS inside the text instead of OpenAI-style `tool_calls`:
 *   <|tool_calls_section_begin|><|tool_call_begin|>functions.run_shell:5
 *   <|tool_call_argument_begin|>{"command":"..."}<|tool_call_end|><|tool_calls_section_end|>
 * Without parsing, these leak as raw text AND the commands never run. Convert them
 * to real ToolCalls so the exec loop executes them.
 */
export function parseSpecialToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const re =
    /<\|tool_call_begin\|>\s*(?:functions\.)?([A-Za-z0-9_.\-]+?)(?::(\d+))?\s*<\|tool_call_argument_begin\|>\s*(\{[\s\S]*?\})\s*<\|tool_call_end\|>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const rawName = m[1];
    const name = rawName.includes(".") ? rawName.slice(rawName.lastIndexOf(".") + 1) : rawName;
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(m[3]);
    } catch {
      args = { _raw: m[3] };
    }
    calls.push({ id: `special_${m[2] ?? calls.length}`, name, arguments: args });
  }
  return calls;
}

/**
 * Strip a model's chain-of-thought and any special control/tool tokens so streamed
 * and stored agent text stays human-readable (no `<|tool_call…|>` noise in panes).
 */
export function cleanAgentText(text: string): string {
  return stripThinking(text)
    .replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g, "")
    .replace(/<\|[a-zA-Z0-9_]+\|>/g, "")
    .trimEnd();
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

  /** Subtasks whose deps are all resolved (done/failed/stopped) and which are still pending. */
  ready(): BoardEntry[] {
    const resolved = (s?: SubtaskStatus) => s === "done" || s === "failed" || s === "stopped";
    return this.all().filter(
      (e) =>
        e.status === "pending" &&
        e.dependsOn.every((d) => {
          const dep = this.entries.get(d);
          return !dep || resolved(dep.status);
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
    const failedDeps = deps.filter((d) => d.status === "failed" || d.status === "stopped");
    if (failedDeps.length) {
      parts.push(
        "\nNOTE — these dependencies did not finish, so their output is missing; compensate as best you can:\n" +
          failedDeps.map((d) => `- [${d.id}] ${d.title} (${d.status})`).join("\n")
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
  /**
   * Where agents may run commands: "off" (default, text-only), "auto" (bare metal
   * for simple plans, Daytona sandbox for complex), "bare", "daytona".
   */
  execMode?: ExecMode;
  /** Host-side settings for the bare executor (cwd, allow/deny lists). */
  bareOpts?: BareExecutorOptions;
  /** Injectable executor (tests). Overrides execMode routing. */
  executor?: AgentExecutor;
  /** Health-check the roster's API keys before running (default honors config). */
  preflight?: boolean;
}

export class CoordinatedSwarm {
  readonly events = new SwarmEvents();
  private workers: SwarmWorker[];
  private lead: Provider;
  private maxTokens: number;
  /** Per-pane abort controllers so a single agent can be stopped (Esc) mid-run. */
  private paneControllers = new Map<number, AbortController>();

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

  /** Stop a single agent's in-flight work (its stream aborts → subtask "stopped"). */
  stopPane(pane: number): void {
    this.paneControllers.get(pane)?.abort();
  }

  /**
   * Health-check the roster's keys; emits preflight events and DROPS broken workers
   * (keeping at least one if all fail, so the run can still surface the error).
   * Returns the results. Safe to call before run().
   */
  async preflight(signal?: AbortSignal): Promise<PreflightResult[]> {
    this.events.emit("preflightStart", { count: this.workers.length });
    const results = await preflightWorkers(this.workers, (r) => this.events.emit("preflight", r));
    const okIdx = new Set(results.filter((r) => r.ok).map((r) => r.pane));
    if (okIdx.size > 0 && okIdx.size < this.workers.length) {
      this.workers = this.workers.filter((_, i) => okIdx.has(i));
    }
    this.events.emit("preflightDone", {
      ok: results.filter((r) => r.ok).length,
      broken: results.filter((r) => !r.ok).length,
    });
    return results;
  }

  /** Run the full coordinated flow: preflight → plan → waves → synthesize. */
  async run(task: string, opts: CoordinateOptions = {}): Promise<SwarmRun> {
    const synth = opts.synthesize !== false;

    // Validate each agent's API key/endpoint up front (drops broken workers).
    const doPreflight = opts.preflight ?? this.config.swarm.preflight;
    if (doPreflight) {
      const pf = await this.preflight(opts.signal);
      if (this.workers.length === 0 || pf.every((r) => !r.ok)) {
        const detail = pf.map((r) => `${r.model}: ${r.detail ?? "unreachable"}`).join("; ");
        const run: SwarmRun = { mode: "divide", results: [] };
        this.events.emit("plan", {
          task,
          subtasks: [],
          roster: this.roster(),
          plannedBy: "(none)",
          note: `all agents failed preflight — ${detail}`,
        } as PlanEvent);
        this.events.emit("done", run);
        return run;
      }
    }

    // Planner candidates: roster order (primary first — fast models lead) with the
    // lead appended; a slow/timing-out lead then costs one attempt, not the plan.
    const planCands = [
      ...new Map(
        [...this.workers.map((w) => w.provider), this.lead].map((p) => [p.model, p])
      ).values(),
    ];
    let subtasks: Subtask[];
    let plannedBy: string;
    let note: string | undefined;
    let complexity: PlanComplexity = "simple";
    if (opts.subtasks && opts.subtasks.length) {
      subtasks = opts.subtasks;
      plannedBy = "(supplied)";
    } else {
      const plan = await decomposeWith(
        planCands,
        task,
        this.workers.length,
        this.maxTokens,
        opts.signal,
        (model) => this.events.emit("planner", { model })
      );
      subtasks = plan.subtasks;
      plannedBy = plan.plannedBy;
      note = plan.note;
      complexity = plan.complexity;
    }

    // Execution backend: bare metal for simple projects, an isolated Daytona
    // sandbox for complex ones (mode "auto"); shared by all agents in the run.
    let executor: AgentExecutor | null = opts.executor ?? null;
    if (!executor && opts.execMode && opts.execMode !== "off") {
      const choice = chooseExecutor(this.config, opts.execMode, complexity, opts.bareOpts);
      executor = choice.executor;
      if (choice.note) note = note ? `${note} · ${choice.note}` : choice.note;
    }

    this.events.emit("plan", {
      task,
      subtasks,
      roster: this.roster(),
      plannedBy,
      note,
      complexity,
      exec: executor?.label,
    } as PlanEvent);

    const board = new Blackboard(subtasks);
    const results: CoordinatedResult[] = [];

    const run: SwarmRun = { mode: "divide", results };
    try {
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
            batch.map((entry, slot) =>
              this.runSubtask(task, board, entry, slot, opts.signal, results, executor)
            )
          );
        }
        waveIndex++;
      }

      if (synth && results.some((r) => r.ok)) {
        this.events.emit("synth", { model: this.lead.model });
        const synthRun: SwarmRun = { mode: "divide", results };
        run.synthesis = await this.synthesizeStreamed(task, synthRun, opts.signal);
        run.synthesizedBy = this.lead.model;
      }

      // Collect generated files (before the sandbox is torn down) for the results pane.
      if (executor) {
        try {
          run.artifacts = await executor.artifacts();
          this.events.emit("artifacts", run.artifacts);
        } catch {
          /* non-fatal */
        }
      }
    } finally {
      // Tear down the run's sandbox even on abort/failure.
      await executor?.dispose().catch(() => {});
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
    sink: CoordinatedResult[],
    executor: AgentExecutor | null = null
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
      { role: "system", content: executor ? swarmAgentExecSystem(executor.label) : SWARM_AGENT_SYSTEM },
      { role: "user", content: prompt },
    ];

    // Per-pane abort controller so the user can stop THIS agent (Esc) without
    // touching the others; it also trips when the whole run is aborted.
    const ctrl = new AbortController();
    const onGlobalAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", onGlobalAbort);
    }
    this.paneControllers.set(pane, ctrl);

    const start = Date.now();
    let text = "";
    const emitDelta = (delta: string) => {
      text += delta;
      this.events.emit("delta", { pane, subtaskId: entry.id, delta } as DeltaEvent);
    };
    try {
      const res = await this.agentLoop(worker, messages, emitDelta, ctrl.signal, executor, pane, entry.id);
      const clean = cleanAgentText(res.text || text).trim();
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
      const msg = (err as Error).message;
      const stopped = ctrl.signal.aborted || /__interrupted__/.test(msg);
      entry.status = stopped ? "stopped" : "failed";
      entry.error = stopped ? "stopped by user" : msg;
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
        text: stopped ? cleanAgentText(text).trim() : "",
        error: entry.error,
        ms: entry.ms,
      };
      sink.push(result);
      this.events.emit("status", {
        pane,
        subtaskId: entry.id,
        status: entry.status,
        ms: entry.ms,
        error: entry.error,
      } as StatusEvent);
      this.events.emit("result", result);
    } finally {
      if (signal) signal.removeEventListener("abort", onGlobalAbort);
      if (this.paneControllers.get(pane) === ctrl) this.paneControllers.delete(pane);
    }
  }

  /**
   * One agent turn — or, when an executor is attached, a bounded tool loop: the
   * model may call run_shell (executed on the run's backend), sees each result,
   * and finishes with a text deliverable. Commands and output tails are emitted
   * as pane deltas so the TUI shows the agent *working*, not just talking.
   */
  private async agentLoop(
    worker: SwarmWorker,
    messages: Message[],
    emitDelta: (d: string) => void,
    signal: AbortSignal | undefined,
    executor: AgentExecutor | null,
    pane: number,
    subtaskId: string
  ): Promise<{ text: string; promptTokens?: number; completionTokens?: number }> {
    const opts = {
      temperature: isReasoningModel(worker.model) ? 0.6 : 0.3,
      max_tokens: this.maxTokens,
      signal,
    };
    if (!executor) return worker.provider.stream(messages, emitDelta, opts);

    const spec: ToolSpec = {
      name: "run_shell",
      description: `Run a non-interactive shell command on ${executor.label}. Returns exit code and output.`,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run." },
          cwd: { type: "string", description: "Working directory (optional)." },
        },
        required: ["command"],
      },
    };
    const maxSteps = Math.max(1, this.config.swarm.exec_max_steps);
    const timeoutMs = Math.max(1, this.config.swarm.exec_timeout_s) * 1000;
    const convo = [...messages];
    let allText = "";
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    for (let step = 0; step <= maxSteps; step++) {
      // Tools are offered until the last step, which forces a final text answer.
      const res = await worker.provider.stream(convo, emitDelta, {
        ...opts,
        tools: step < maxSteps ? [spec] : undefined,
      });
      // Honor OpenAI tool_calls OR special-token tool calls (Kimi on NIM).
      let toolCalls = res.toolCalls;
      if (!toolCalls?.length) {
        const special = parseSpecialToolCalls(res.text);
        if (special.length) toolCalls = special;
      }
      const cleanText = cleanAgentText(res.text);
      if (cleanText) allText += (allText ? "\n" : "") + cleanText;
      promptTokens = res.promptTokens ?? promptTokens;
      completionTokens = (completionTokens ?? 0) + (res.completionTokens ?? 0);
      if (!toolCalls?.length) break;

      convo.push({ role: "assistant", content: cleanText, tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const cmd = String(tc.arguments?.command ?? "").trim();
        const cwd = tc.arguments?.cwd ? String(tc.arguments.cwd) : undefined;
        emitDelta(`\n$ ${cmd}\n`);
        const r = cmd
          ? await executor.run(cmd, { cwd, timeoutMs })
          : { ok: false, exitCode: null, output: "run_shell: 'command' is required." };
        const tail = (r.output || "").slice(-1200);
        emitDelta(tail + (r.ok ? "\n" : `\n[exit ${r.exitCode ?? "?"}]\n`));
        this.events.emit("execCmd", { pane, subtaskId, command: cmd, ok: r.ok });
        convo.push({
          role: "tool",
          content: `exit=${r.exitCode ?? "null"} ok=${r.ok}\n${tail}`,
          tool_call_id: tc.id,
          name: "run_shell",
        });
      }
    }
    return { text: allText, promptTokens, completionTokens };
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
          `A team of agents completed the subtasks below, sharing context as they went. Write ONE clear, ` +
          `human-readable final report in Markdown that integrates their work:\n` +
          `- a short summary of what was built/decided;\n` +
          `- the files or artifacts produced, with their paths;\n` +
          `- the key code in fenced \`\`\` code blocks (real newlines — NEVER a raw JSON object of escaped file contents);\n` +
          `- how to run or use it.\n` +
          `Reconcile overlaps and contradictions; do not mention the team or the process.\n\n` +
          `${blocks}\n\n--- Write the integrated Markdown report below. ---`,
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
    return dep && dep.status !== "done" && dep.status !== "failed" && dep.status !== "stopped";
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
