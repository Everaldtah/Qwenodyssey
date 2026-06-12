/**
 * Execution backends for swarm agents. The coordinated swarm routes a run's
 * shell work to one of two places, chosen by the PLANNER's complexity judgment:
 *
 *  - "bare"    — the user's own machine (host CLI). For LESS complex work.
 *                Every command goes through the same safety gate as run_shell
 *                (classifyCommand: hard-blocks, destructive detection, the
 *                config allow/deny lists) — and DESTRUCTIVE commands are flatly
 *                refused (a swarm agent has no interactive confirm).
 *  - "daytona" — an isolated Daytona sandbox (https://daytona.io). For MORE
 *                complex work (dependency installs, multi-file builds, servers).
 *                One sandbox per swarm run, shared by all agents so their files
 *                compose; deleted on dispose. Zero-dependency REST integration:
 *                POST /sandbox, POST /toolbox/{id}/toolbox/process/execute,
 *                DELETE /sandbox/{id}; bearer auth via DAYTONA_API_KEY.
 *
 * Mode "auto" = bare for simple plans, daytona for complex plans when a key is
 * configured (falls back to bare with a note when not).
 */
import execa from "execa";
import type { Config } from "./config";
import { classifyCommand, PS_PREAMBLE } from "../tools/shellTools";

export type ExecKind = "bare" | "daytona";
export type ExecMode = "off" | "auto" | ExecKind;
export type PlanComplexity = "simple" | "complex";

export interface ExecResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export interface AgentExecutor {
  readonly kind: ExecKind;
  /** Short label for UI ("bare metal" / "daytona sandbox"). */
  readonly label: string;
  run(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
  /** Release resources (delete the sandbox). Safe to call more than once. */
  dispose(): Promise<void>;
}

/* ─────────────────────────── bare metal (host) ─────────────────────────── */

export interface BareExecutorOptions {
  cwd?: string;
  allowCommands?: string[];
  denyCommands?: string[];
  defaultTimeoutMs?: number;
}

export class BareExecutor implements AgentExecutor {
  readonly kind = "bare" as const;
  readonly label = "bare metal";

  constructor(private opts: BareExecutorOptions = {}) {}

  async run(command: string, o: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    const cls = classifyCommand(command, {
      allow: this.opts.allowCommands,
      deny: this.opts.denyCommands,
    });
    if (cls === "blocked") {
      return { ok: false, exitCode: null, output: "Refused: command is hard-blocked on this machine." };
    }
    if (cls === "destructive") {
      return {
        ok: false,
        exitCode: null,
        output:
          "Refused: command looks destructive and swarm agents cannot confirm interactively. " +
          "Rephrase non-destructively, or the user can add it to tools.allow_commands.",
      };
    }
    const timeout = o.timeoutMs ?? this.opts.defaultTimeoutMs ?? 120_000;
    const cwd = o.cwd ?? this.opts.cwd ?? process.cwd();
    const common = { cwd, timeout, reject: false, all: true } as const;
    try {
      const result =
        process.platform === "win32"
          ? await execa(
              "powershell.exe",
              ["-NoProfile", "-NonInteractive", "-InputFormat", "None", "-ExecutionPolicy", "Bypass", "-Command", PS_PREAMBLE + command],
              { ...common, stdin: "ignore", windowsVerbatimArguments: false }
            )
          : await execa(command, { ...common, shell: true });
      const output = (result.all ?? result.stdout ?? "").toString();
      return { ok: result.exitCode === 0, exitCode: result.exitCode ?? null, output };
    } catch (err) {
      return { ok: false, exitCode: null, output: (err as Error).message };
    }
  }

  async dispose(): Promise<void> {
    /* nothing to release on the host */
  }
}

/* ───────────────────────── daytona sandbox (cloud) ─────────────────────── */

export function resolveDaytonaKey(config: Config): string {
  const d = config.daytona;
  return d.api_key || process.env[d.api_key_env || "DAYTONA_API_KEY"] || "";
}

export function daytonaAvailable(config: Config): boolean {
  return !!config.daytona.enabled && !!resolveDaytonaKey(config);
}

export class DaytonaExecutor implements AgentExecutor {
  readonly kind = "daytona" as const;
  readonly label = "daytona sandbox";
  private sandboxId: string | null = null;
  private creating: Promise<string> | null = null;
  private disposed = false;

  constructor(
    private config: Config,
    /** Injectable for tests. */
    private fetchFn: typeof fetch = fetch
  ) {}

  private base(): string {
    return (this.config.daytona.base_url || "https://app.daytona.io/api").replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resolveDaytonaKey(this.config)}`,
    };
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.fetchFn(`${this.base()}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "<no body>");
      throw new Error(`daytona HTTP ${res.status} on ${method} ${path}: ${detail.slice(0, 200)}`);
    }
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { raw: text };
    }
  }

  /** Create the run's sandbox once; concurrent callers share the same creation. */
  private ensureSandbox(): Promise<string> {
    if (this.sandboxId) return Promise.resolve(this.sandboxId);
    if (!this.creating) {
      this.creating = (async () => {
        const d = this.config.daytona;
        const body: Record<string, unknown> = {
          name: `qod-swarm-${Date.now().toString(36)}`,
          labels: { app: "qwenodyssey-swarm" },
          autoStopInterval: d.auto_stop_minutes,
          autoDeleteInterval: d.auto_delete_minutes,
        };
        if (d.snapshot) body.snapshot = d.snapshot;
        if (d.target) body.target = d.target;
        const sb = await this.api("POST", "/sandbox", body);
        const id: string = sb.id;
        // Wait until the sandbox is running (state "started").
        const deadline = Date.now() + 120_000;
        let state: string = sb.state ?? "creating";
        while (state !== "started" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const cur = await this.api("GET", `/sandbox/${id}`);
          state = cur.state ?? state;
          if (state === "error" || cur.errorReason) {
            throw new Error(`daytona sandbox failed to start: ${cur.errorReason ?? state}`);
          }
        }
        if (state !== "started") throw new Error("daytona sandbox start timed out (120s)");
        this.sandboxId = id;
        return id;
      })();
      // A failed creation should be retryable on the next run() call.
      this.creating.catch(() => (this.creating = null));
    }
    return this.creating;
  }

  async run(command: string, o: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    if (this.disposed) return { ok: false, exitCode: null, output: "daytona executor already disposed" };
    try {
      const id = await this.ensureSandbox();
      const body: Record<string, unknown> = {
        command,
        timeout: Math.max(1, Math.ceil((o.timeoutMs ?? 120_000) / 1000)),
      };
      if (o.cwd) body.cwd = o.cwd;
      const res = await this.api("POST", `/toolbox/${id}/toolbox/process/execute`, body);
      const exitCode = typeof res.exitCode === "number" ? res.exitCode : null;
      return { ok: exitCode === 0, exitCode, output: String(res.result ?? "") };
    } catch (err) {
      return { ok: false, exitCode: null, output: (err as Error).message };
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sandboxId) {
      try {
        await this.api("DELETE", `/sandbox/${this.sandboxId}`);
      } catch {
        /* best-effort cleanup; autoDeleteInterval is the backstop */
      }
      this.sandboxId = null;
    }
  }
}

/* ───────────────────────────── mode routing ────────────────────────────── */

export interface ExecutorChoice {
  executor: AgentExecutor | null;
  /** Diagnostic for the UI (e.g. why daytona was requested but bare was used). */
  note?: string;
}

/**
 * Pick the execution backend for a swarm run.
 *   off            → none (agents are text-only, the previous behavior)
 *   bare / daytona → forced
 *   auto           → complexity "complex" + Daytona configured → daytona,
 *                    otherwise bare
 */
export function chooseExecutor(
  config: Config,
  mode: ExecMode,
  complexity: PlanComplexity,
  bareOpts: BareExecutorOptions = {}
): ExecutorChoice {
  if (mode === "off") return { executor: null };
  if (mode === "bare") return { executor: new BareExecutor(bareOpts) };
  if (mode === "daytona") {
    if (!daytonaAvailable(config)) {
      return {
        executor: new BareExecutor(bareOpts),
        note: "daytona requested but no DAYTONA_API_KEY — using bare metal",
      };
    }
    return { executor: new DaytonaExecutor(config) };
  }
  // auto
  if (complexity === "complex") {
    if (daytonaAvailable(config)) return { executor: new DaytonaExecutor(config) };
    return {
      executor: new BareExecutor(bareOpts),
      note: "complex plan — daytona not configured, using bare metal",
    };
  }
  return { executor: new BareExecutor(bareOpts) };
}
