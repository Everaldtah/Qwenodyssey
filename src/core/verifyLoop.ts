/**
 * Verify-in-the-loop.
 *
 * The reliable way to lift a small model to strong coding output is to *close
 * the loop*: after an edit, actually run the type checker / linter / tests and
 * feed the structured failures back so the next attempt is grounded in reality
 * rather than the model's imagination. Frontier models can sometimes one-shot;
 * small models need the feedback loop, and with it they reach comparable
 * correctness on well-scoped tasks.
 *
 * This module auto-detects the project's check commands and runs them with a
 * timeout, returning a compact, de-duplicated, model-friendly error digest
 * (truncated, most-relevant-first) rather than a wall of raw output.
 */
import * as fs from "fs";
import * as path from "path";
import execa from "execa";

export interface CheckCommand {
  kind: "typecheck" | "lint" | "test" | "build";
  cmd: string;
  args: string[];
  /** Working directory (defaults to project root). */
  cwd?: string;
}

export interface CheckResult {
  kind: CheckCommand["kind"];
  cmd: string;
  passed: boolean;
  durationMs: number;
  /** Compact, model-friendly digest of failures (empty when passed). */
  digest: string;
  /** Raw tail, for debugging. */
  rawTail: string;
  timedOut: boolean;
}

interface PkgJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function readPkg(root: string): PkgJson | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
  } catch {
    return null;
  }
}

const has = (p: string, f: string) => fs.existsSync(path.join(p, f));

/**
 * Detect the check commands available in a project. Order matters: typecheck and
 * lint are fast feedback; tests are the ground truth; build last.
 */
export function detectChecks(root: string): CheckCommand[] {
  const checks: CheckCommand[] = [];
  const pkg = readPkg(root);
  const scripts = pkg?.scripts ?? {};
  const allDeps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };

  // ── Node / TypeScript ──
  if (pkg) {
    const runner = has(root, "pnpm-lock.yaml") ? "pnpm" : has(root, "yarn.lock") ? "yarn" : "npm";
    const runScript = (name: string) => (runner === "npm" ? ["run", name] : [name]);

    if (scripts.typecheck) checks.push({ kind: "typecheck", cmd: runner, args: runScript("typecheck") });
    else if (allDeps.typescript && has(root, "tsconfig.json")) {
      checks.push({ kind: "typecheck", cmd: "npx", args: ["tsc", "--noEmit"] });
    }
    if (scripts.lint) checks.push({ kind: "lint", cmd: runner, args: runScript("lint") });
    if (scripts.test) checks.push({ kind: "test", cmd: runner, args: runScript("test") });
    if (scripts.build) checks.push({ kind: "build", cmd: runner, args: runScript("build") });
    return checks;
  }

  // ── Python ──
  if (has(root, "pyproject.toml") || has(root, "setup.py") || has(root, "requirements.txt")) {
    if (has(root, "mypy.ini") || has(root, "pyproject.toml")) {
      checks.push({ kind: "typecheck", cmd: "python3", args: ["-m", "mypy", "."] });
    }
    checks.push({ kind: "lint", cmd: "python3", args: ["-m", "ruff", "check", "."] });
    checks.push({ kind: "test", cmd: "python3", args: ["-m", "pytest", "-q"] });
    return checks;
  }

  // ── Go ──
  if (has(root, "go.mod")) {
    checks.push({ kind: "build", cmd: "go", args: ["build", "./..."] });
    checks.push({ kind: "test", cmd: "go", args: ["test", "./..."] });
    return checks;
  }

  // ── Rust ──
  if (has(root, "Cargo.toml")) {
    checks.push({ kind: "typecheck", cmd: "cargo", args: ["check"] });
    checks.push({ kind: "test", cmd: "cargo", args: ["test"] });
    return checks;
  }

  return checks;
}

/** Compress raw tool output into a model-friendly error digest. */
export function digestErrors(kind: CheckCommand["kind"], output: string, maxLines = 40): string {
  const lines = output.split("\n");
  // Heuristic: lines that look like errors/warnings/failures get priority.
  const errorRe = /\b(error|fail(ed|ure)?|exception|cannot find|not assignable|undefined|expected|Traceback|panic:|FAILED|✗|×)\b/i;
  const fileLineRe = /([\w./\\-]+\.(ts|tsx|js|jsx|py|go|rs|java|kt|c|cpp|rb|php)):(\d+)/i;

  const priority: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const t = l.trimEnd();
    if (!t.trim()) continue;
    if (errorRe.test(t) || fileLineRe.test(t)) {
      const key = t.trim();
      if (!seen.has(key)) {
        seen.add(key);
        priority.push(t);
      }
    }
    if (priority.length >= maxLines) break;
  }

  if (priority.length) {
    const more = priority.length >= maxLines ? `\n… (${kind} output truncated)` : "";
    return priority.join("\n") + more;
  }
  // Nothing matched the error heuristic — return the tail.
  const tail = lines.slice(-maxLines).join("\n").trim();
  return tail || "(no output)";
}

/** Run a single check with a timeout; never throws. */
export async function runCheck(root: string, check: CheckCommand, timeoutMs = 120_000): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const res = await execa(check.cmd, check.args, {
      cwd: check.cwd ?? root,
      timeout: timeoutMs,
      reject: false,
      all: true,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    });
    const out = res.all ?? `${res.stdout}\n${res.stderr}`;
    const passed = res.exitCode === 0;
    return {
      kind: check.kind,
      cmd: `${check.cmd} ${check.args.join(" ")}`,
      passed,
      durationMs: Date.now() - t0,
      digest: passed ? "" : digestErrors(check.kind, out),
      rawTail: out.split("\n").slice(-60).join("\n"),
      timedOut: Boolean((res as any).timedOut),
    };
  } catch (err) {
    return {
      kind: check.kind,
      cmd: `${check.cmd} ${check.args.join(" ")}`,
      passed: false,
      durationMs: Date.now() - t0,
      digest: `Could not run ${check.kind}: ${(err as Error).message}`,
      rawTail: (err as Error).message,
      timedOut: /timed out/i.test((err as Error).message),
    };
  }
}

export interface VerifyOptions {
  /** Restrict to these kinds (e.g. only fast checks during an inner loop). */
  only?: CheckCommand["kind"][];
  /** Stop at the first failing check (fast-fail) instead of running all. */
  stopOnFirstFailure?: boolean;
  timeoutMs?: number;
}

export interface VerifyOutcome {
  ran: boolean;
  allPassed: boolean;
  results: CheckResult[];
  /** Combined model-friendly feedback for the failing checks. */
  feedback: string;
}

/**
 * Run the detected checks and assemble a single feedback string for the model.
 * The orchestrator/error-fixer can paste `feedback` straight into the next turn.
 */
export async function verify(root: string, opts: VerifyOptions = {}): Promise<VerifyOutcome> {
  let checks = detectChecks(root);
  if (opts.only) checks = checks.filter((c) => opts.only!.includes(c.kind));
  if (!checks.length) return { ran: false, allPassed: true, results: [], feedback: "" };

  const results: CheckResult[] = [];
  for (const c of checks) {
    const r = await runCheck(root, c, opts.timeoutMs);
    results.push(r);
    if (!r.passed && opts.stopOnFirstFailure) break;
  }

  const failing = results.filter((r) => !r.passed);
  const allPassed = failing.length === 0;
  const feedback = failing.length
    ? failing
        .map((r) => `### ${r.kind} FAILED (${r.cmd})\n${r.digest}`)
        .join("\n\n")
    : "";

  return { ran: true, allPassed, results, feedback };
}
