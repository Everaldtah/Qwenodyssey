import { adaptChainsForPowerShell } from "./psCompat";
/**
 * Persistent, stateful shell session backed by a real pseudo-terminal (node-pty).
 *
 * The default `run_shell` tool spawns a FRESH shell per command, so `cd`,
 * activated venvs, exported env vars, and long-running processes (servers,
 * watchers, REPLs) don't survive between calls. A ShellSession keeps ONE shell
 * process alive for the whole chat session: state persists, long-running
 * commands can be started and polled instead of blocking-or-dying, and
 * interactive prompts can be answered by sending more input.
 *
 * node-pty is a NATIVE module and an OPTIONAL dependency — if it isn't installed
 * (or failed to build), the session degrades gracefully: start() reports the
 * problem and the tools tell the user to `npm install node-pty`, while the rest
 * of the harness keeps working with the one-shot run_shell tool.
 *
 * Command boundaries: a pty is just a byte stream with no notion of "command
 * finished", so after each command we write a unique sentinel that echoes the
 * exit code (`<TOKEN>:<code>`). Seeing that line on its own means the command
 * returned to the prompt; not seeing it within the timeout means it's still
 * running, and the caller can poll with read().
 */

export type RunStatus = "done" | "running" | "busy" | "error" | "idle";

export interface RunResult {
  status: RunStatus;
  output: string;
  exitCode?: number | null;
}

interface Job {
  marker: string;
  command: string; // the command the user sent, so we can drop its terminal echo
  raw: string; // all pty output for this command, pre-clean
  done: boolean;
  exitCode: number | null;
  cleanConsumed: number; // how much of the cleaned output the caller has already seen
  timer: ReturnType<typeof setTimeout> | null;
  waiter: ((r: RunResult) => void) | null;
}

const isWin = process.platform === "win32";

/** Strip ANSI escape / control sequences a pty interleaves into the stream. */
function stripAnsi(s: string): string {
  // CSI sequences, OSC sequences, and lone carriage returns.
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC (e.g. window title)
    .replace(/\x1b[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[=>]/g, "")
    .replace(/\r(?!\n)/g, "");
}

export class ShellSession {
  private pty: any = null;
  private current: Job | null = null;
  private alive = false;
  private startError?: string;
  private warm: Promise<void> | null = null;
  private sawData = false;
  private onFirstData: (() => void) | null = null;

  constructor(private cwd: string) {}

  /** Try to load the optional native module. */
  private static load(): any | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require("node-pty");
    } catch {
      return null;
    }
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /** Spawn the persistent shell. Idempotent while alive. */
  start(): { ok: boolean; error?: string } {
    if (this.alive) return { ok: true };
    const mod = ShellSession.load();
    if (!mod) {
      this.startError = "node-pty is not installed. Run `npm install node-pty` to enable persistent shell sessions.";
      return { ok: false, error: this.startError };
    }
    const shell = isWin ? "powershell.exe" : process.env.SHELL || "bash";
    const args = isWin ? ["-NoLogo", "-NoProfile"] : [];
    try {
      this.pty = mod.spawn(shell, args, {
        name: "xterm-color",
        // Very wide so long command/marker lines never wrap (wrapping under conpty
        // corrupts the echoed input and can swallow the completion sentinel).
        cols: 1000,
        rows: 30,
        cwd: this.cwd,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      this.startError = `failed to spawn shell: ${(err as Error).message}`;
      return { ok: false, error: this.startError };
    }
    this.alive = true;
    this.pty.onData((d: string) => this.onData(d));
    this.pty.onExit(() => {
      this.alive = false;
      // Unblock any waiter so the caller isn't left hanging.
      if (this.current && !this.current.done) {
        this.current.done = true;
        this.current.exitCode = null;
        this.settle();
      }
    });
    return { ok: true };
  }

  private markerCmd(token: string): string {
    // Keep this SHORT and parse-trivial — a long/paren-heavy marker is fragile to
    // conpty echo mangling. `$LASTEXITCODE` is the native-exe exit code (empty for
    // pure cmdlets, which we treat as success). On failure of a native command it
    // carries the real non-zero code.
    return isWin ? `Write-Output "${token}:$LASTEXITCODE"` : `echo "${token}:$?"`;
  }

  /** Locate the sentinel RESULT line (token at line start, then the exit code). */
  private findMarker(raw: string, token: string): { index: number; code: number | null } | null {
    // A (blanked) prompt may be glued in front of the result line: "PS> QOD…:0".
    const re = new RegExp(`(?:^|\\n)(?:PS[^>\\n]*>\\s?)?${token}:(-?\\d*)\\r?\\n`);
    const m = re.exec(raw);
    if (!m) return null;
    const code = m[1] === "" ? null : Number(m[1]);
    return { index: m.index, code };
  }

  /**
   * Wait for the shell to be ready for input, then quiet it (blank prompt, drop
   * PSReadLine's syntax-highlight reflow that mangles echoed input). Writing the
   * first command before conpty has attached the shell's input reader silently
   * drops it, so the first run() must await this. Idempotent.
   */
  private warmup(): Promise<void> {
    if (this.warm) return this.warm;
    this.warm = new Promise<void>((resolve) => {
      const quietAndSettle = () => {
        // Blank the prompt for clean output. Do NOT remove PSReadLine — doing so
        // mid-session wedges the input reader and the next command is lost; its
        // syntax-highlight ANSI is harmless (stripped on read). Also default
        // Invoke-WebRequest/RestMethod to -UseBasicParsing + silence progress so
        // web cmdlets don't stall on the legacy IE engine.
        if (isWin) {
          this.pty.write(
            "function prompt { '' }; $ProgressPreference='SilentlyContinue'; " +
              "$PSDefaultParameterValues['Invoke-WebRequest:UseBasicParsing']=$true; " +
              "$PSDefaultParameterValues['Invoke-RestMethod:UseBasicParsing']=$true\r"
          );
        } else {
          this.pty.write("PS1=''\r");
        }
        setTimeout(resolve, 400); // let the init line run; its output is discarded (no active job)
      };
      if (this.sawData) quietAndSettle();
      else this.onFirstData = quietAndSettle;
      // Fallback: proceed even if the data event never fires.
      setTimeout(() => {
        if (this.onFirstData) {
          this.onFirstData = null;
          quietAndSettle();
        }
      }, 1500);
    });
    return this.warm;
  }

  private onData(d: string): void {
    if (!this.sawData) {
      this.sawData = true;
      const cb = this.onFirstData;
      this.onFirstData = null;
      if (cb) cb();
    }
    const job = this.current;
    if (!job || job.done) return;
    job.raw += d;
    // conpty interleaves ANSI (e.g. "\x1b[m") between the newline and the marker,
    // so match on the STRIPPED text — matching the raw bytes never saw the
    // sentinel, every command "ran" until its timeout, and the session then
    // reported "busy" for the rest of the chat.
    const plain = stripAnsi(job.raw);
    const m = this.findMarker(plain, job.marker);
    if (m) {
      job.done = true;
      job.exitCode = m.code;
      job.raw = plain.slice(0, m.index);
      this.settle();
    }
  }

  /** Resolve the in-flight waiter (if any) with the finished result. */
  private settle(): void {
    const job = this.current;
    if (!job || !job.waiter) return;
    if (job.timer) clearTimeout(job.timer);
    const w = job.waiter;
    job.waiter = null;
    job.timer = null;
    w(this.deltaResult());
  }

  /** Cleaned output the caller hasn't seen yet, advancing the consumed pointer. */
  private deltaResult(): RunResult {
    const job = this.current!;
    const cleaned = this.cleanedOutput(job);
    const delta = cleaned.slice(job.cleanConsumed);
    job.cleanConsumed = cleaned.length;
    return {
      status: job.done ? "done" : "running",
      output: delta,
      exitCode: job.done ? job.exitCode : undefined,
    };
  }

  /** Clean a job's raw buffer: drop ANSI, the echoed command/marker lines, prompts. */
  private cleanedOutput(job: Job): string {
    const text = stripAnsi(job.raw);
    const cmd = job.command.trim();
    // The line actually sent to PowerShell may differ (bash-chain rewrite).
    const wireCmd = process.platform === "win32" ? adaptChainsForPowerShell(cmd).trim() : cmd;
    const out: string[] = [];
    for (let line of text.split("\n")) {
      // Strip a leading PowerShell prompt ("PS C:\path> " or the blanked "PS> "),
      // which conpty often glues onto the echoed command line.
      line = line.replace(/^PS[^>\n]*>\s?/, "").replace(/\r$/, "");
      if (line.includes(job.marker)) continue; // echoed marker command / result line
      if (line.trim() === cmd || line.trim() === wireCmd) continue; // the terminal-echoed input command
      // Startup init echo can bleed into the first command's buffer (it's written
      // before any job exists) — drop it.
      if (/function prompt \{|^PS1=''/.test(line)) continue;
      out.push(line);
    }
    // Collapse leading/trailing blank lines and runs of blanks.
    return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/g, "");
  }

  /**
   * Run a command in the persistent shell. Waits up to `timeoutMs` for it to
   * finish; if it's still running by then, returns status "running" with the
   * output so far — poll read() for the rest.
   */
  async run(command: string, timeoutMs = 15000): Promise<RunResult> {
    if (!this.alive) {
      const r = this.start();
      if (!r.ok) return { status: "error", output: r.error || this.startError || "shell unavailable" };
    }
    await this.warmup(); // ensure the shell is attached + quieted before the first command
    if (this.current && !this.current.done) {
      return {
        status: "busy",
        output:
          "A previous command is still running in this session. Use shell_session_read to read its output, " +
          "or wait for it to finish before sending another command.",
      };
    }
    const token = "QOD" + Math.random().toString(36).slice(2, 10).toUpperCase();
    // Windows PowerShell 5.1 has no `&&`/`||` — rewrite bash-style chains.
    const wire = process.platform === "win32" ? adaptChainsForPowerShell(command) : command;
    this.current = { marker: token, command, raw: "", done: false, exitCode: null, cleanConsumed: 0, timer: null, waiter: null };
    // Single write of both lines — avoids an inter-write race where the marker
    // arrives while the shell is still echoing the command.
    this.pty.write(wire + "\r" + this.markerCmd(token) + "\r");
    return this.waitForDelta(timeoutMs);
  }

  /** Poll a still-running command for more output (and whether it has finished). */
  async read(timeoutMs = 10000): Promise<RunResult> {
    const job = this.current;
    if (!job) return { status: "idle", output: "No command has been run in this session yet." };
    if (job.done) return this.deltaResult(); // returns remaining tail + done
    return this.waitForDelta(timeoutMs);
  }

  /** Send raw input to the live shell (e.g. answer an interactive prompt). */
  write(input: string): void {
    if (this.alive) this.pty.write(input);
  }

  private waitForDelta(timeoutMs: number): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      const job = this.current!;
      if (job.done) return resolve(this.deltaResult());
      job.waiter = resolve;
      job.timer = setTimeout(() => {
        job.waiter = null;
        job.timer = null;
        resolve(this.deltaResult()); // status "running" with whatever arrived
      }, timeoutMs);
    });
  }

  /** Kill and forget the shell; a later run() will start a fresh one. */
  reset(): void {
    this.dispose();
  }

  dispose(): void {
    if (this.current?.timer) clearTimeout(this.current.timer);
    this.current = null;
    if (this.pty) {
      try {
        this.pty.kill();
      } catch {
        /* already gone */
      }
    }
    this.pty = null;
    this.alive = false;
    this.warm = null;
    this.sawData = false;
    this.onFirstData = null;
  }
}
