/**
 * Live split-pane TUI for the coordinated swarm. Subscribes to a SwarmEvents
 * emitter and paints one terminal pane per agent, each streaming that agent's
 * tokens in real time (status glyph + model + current subtask + elapsed). A header
 * shows the overall task/wave; a footer shows progress. On finish it restores the
 * terminal (leaves the alternate screen) so the normal scrollback is intact and the
 * caller can print the durable text summary.
 *
 * Dependency-free: raw ANSI + chalk, modeled on src/cli/render.ts's Spinner. TTY-
 * gated — when stdout is not a TTY (piped/redirected/tests) start() is a no-op and
 * the caller falls back to a plain line logger.
 */
import chalk from "chalk";
import type {
  SwarmEvents,
  PlanEvent,
  AssignEvent,
  DeltaEvent,
  StatusEvent,
  WaveEvent,
  SubtaskStatus,
} from "../core/swarmCoordinator";

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const HOME = "\x1b[H";
const CLEAR_EOL = "\x1b[K";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface PaneState {
  subtaskId?: string;
  title: string;
  model: string;
  status: SubtaskStatus | "idle";
  buffer: string;
  startedAt: number;
  ms?: number;
}

export interface SwarmTuiOptions {
  task: string;
  /** Number of worker slots (panes). */
  panes: number;
  /** Label note, e.g. "(local fallback — no frontier key)". */
  note?: string;
}

export class SwarmTui {
  private panes: PaneState[];
  private timer?: ReturnType<typeof setInterval>;
  private startedAt = 0;
  private frame = 0;
  private waveIndex = 0;
  private subtaskCount = 0;
  private doneCount = 0;
  private failCount = 0;
  private synthModel?: string;
  private synthChars = 0;
  private running = false;
  private readonly out = process.stdout;

  constructor(private events: SwarmEvents, private opts: SwarmTuiOptions) {
    this.panes = Array.from({ length: Math.max(1, opts.panes) }, () => ({
      title: "",
      model: "",
      status: "idle" as const,
      buffer: "",
      startedAt: 0,
    }));
  }

  /** Whether a live TUI can run in this environment. */
  static supported(): boolean {
    return !!process.stdout.isTTY && (process.stdout.columns ?? 0) >= 40;
  }

  start(): void {
    if (!SwarmTui.supported()) return;
    this.running = true;
    this.startedAt = Date.now();
    this.wire();
    this.out.write(ALT_SCREEN_ON + HIDE_CURSOR);
    this.draw();
    this.timer = setInterval(() => this.draw(), 100);
    this.timer.unref?.();
  }

  /** Stop painting and restore the normal screen. Safe to call once. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.out.write(SHOW_CURSOR + ALT_SCREEN_OFF);
  }

  /* ── event wiring ── */

  private wire(): void {
    this.events.on("plan", (e: PlanEvent) => {
      this.subtaskCount = e.subtasks.length;
      // Seed pane model labels from the roster so idle panes still show who's who.
      e.roster.forEach((r, i) => {
        if (this.panes[i]) this.panes[i].model = r.label;
      });
    });
    this.events.on("wave", (e: WaveEvent) => {
      this.waveIndex = e.index;
    });
    this.events.on("assign", (e: AssignEvent) => {
      const p = this.panes[e.pane % this.panes.length];
      p.subtaskId = e.subtaskId;
      p.title = e.title;
      p.model = e.workerLabel || p.model;
      p.status = "running";
      p.buffer = "";
      p.startedAt = Date.now();
      p.ms = undefined;
    });
    this.events.on("delta", (e: DeltaEvent) => {
      const p = this.panes[e.pane % this.panes.length];
      p.buffer += e.delta;
      // Keep the buffer from growing unbounded; we only ever render the tail.
      if (p.buffer.length > 8000) p.buffer = p.buffer.slice(-6000);
    });
    this.events.on("status", (e: StatusEvent) => {
      const p = this.panes[e.pane % this.panes.length];
      p.status = e.status;
      if (e.ms != null) p.ms = e.ms;
      if (e.status === "done") this.doneCount++;
      if (e.status === "failed") this.failCount++;
    });
    this.events.on("synth", (e: { model: string }) => {
      this.synthModel = e.model;
      this.synthChars = 0;
    });
    this.events.on("synthDelta", (e: { delta: string }) => {
      this.synthChars += e.delta.length;
    });
  }

  /* ── rendering ── */

  private draw(): void {
    if (!this.running) return;
    this.frame++;
    const width = this.out.columns || 80;
    const height = this.out.rows || 24;
    const lines: string[] = [];

    lines.push(this.header(width));

    // Grid geometry.
    const n = this.panes.length;
    const cols = Math.max(1, Math.min(n, Math.floor(width / 30) || 1, Math.ceil(Math.sqrt(n))));
    const rows = Math.ceil(n / cols);
    const gridHeight = Math.max(rows * 3, height - 2 - (this.synthModel ? 1 : 0));
    const paneH = Math.max(3, Math.floor(gridHeight / rows));
    const gap = 1;
    const paneW = Math.max(20, Math.floor((width - gap * (cols - 1)) / cols));

    for (let r = 0; r < rows; r++) {
      const rowPanes: string[][] = [];
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        rowPanes.push(idx < n ? this.renderPane(this.panes[idx], paneW, paneH) : blankPane(paneW, paneH));
      }
      for (let k = 0; k < paneH; k++) {
        lines.push(rowPanes.map((p) => p[k]).join(" ".repeat(gap)));
      }
    }

    if (this.synthModel) lines.push(this.synthLine(width));
    lines.push(this.footer(width));

    // Paint: home, then each line cleared to EOL. Trim to terminal height.
    const visible = lines.slice(0, height);
    this.out.write(HOME + visible.map((l) => l + CLEAR_EOL).join("\n"));
  }

  private header(width: number): string {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const left = chalk.bold("🜂 swarm") + chalk.gray(`  ${this.opts.task}`);
    const right = chalk.gray(`wave ${this.waveIndex + 1} · ${fmtElapsed(elapsed)}`);
    return padBetween(stripToWidth(left, width - stripAnsi(right).length - 1, true), right, width);
  }

  private footer(width: number): string {
    const note = this.opts.note ? chalk.yellow(` ${this.opts.note}`) : "";
    const fails = this.failCount ? chalk.red(` · ${this.failCount} failed`) : "";
    const prog = chalk.gray(`${this.doneCount}/${this.subtaskCount || this.panes.length} done`);
    return truncVisible(prog + fails + note + chalk.gray("   Ctrl-C aborts"), width);
  }

  private synthLine(width: number): string {
    const g = SPIN[this.frame % SPIN.length];
    return truncVisible(
      chalk.magenta(`${g} synthesizing`) +
        chalk.gray(` with ${this.synthModel} · ${this.synthChars} chars`),
      width
    );
  }

  /** Produce exactly paneH lines, each visually paneW wide. */
  private renderPane(p: PaneState, paneW: number, paneH: number): string[] {
    const glyph = statusGlyph(p.status, this.frame);
    const elapsed = p.status === "running" && p.startedAt
      ? fmtElapsed(Math.floor((Date.now() - p.startedAt) / 1000))
      : p.ms != null
        ? fmtElapsed(Math.round(p.ms / 1000))
        : "";
    const titlePlain = ` ${stripAnsi(glyph)} ${p.model || "—"}${p.title ? " · " + p.title : ""} `;
    // Title bar: ┌ … ┐ with elapsed pinned right.
    const inner = paneW - 2;
    const elapTag = elapsed ? `${elapsed} ` : "";
    const titleFit = padTrunc(titlePlain.replace(/\s+$/, ""), Math.max(0, inner - elapTag.length));
    const titleColored = colorTitle(titleFit, p.status) + chalk.gray(elapTag);
    const top = chalk.gray("┌") + titleColored + chalk.gray("┐");

    const bodyH = paneH - 1;
    const bodyLines = tailWrap(p.buffer, inner, bodyH);
    const body: string[] = [];
    for (let i = 0; i < bodyH; i++) {
      const text = bodyLines[i] ?? "";
      body.push(chalk.gray("│") + chalk.dim(padTrunc(text, inner)) + chalk.gray("│"));
    }
    return [top, ...body];
  }
}

/* ──────────────────────────── helpers ──────────────────────────── */

function statusGlyph(status: PaneState["status"], frame: number): string {
  switch (status) {
    case "running":
      return chalk.cyan(SPIN[frame % SPIN.length]);
    case "done":
      return chalk.green("✓");
    case "failed":
      return chalk.red("✗");
    default:
      return chalk.gray("·");
  }
}

function colorTitle(s: string, status: PaneState["status"]): string {
  if (status === "done") return chalk.green(s);
  if (status === "failed") return chalk.red(s);
  if (status === "running") return chalk.cyan(s);
  return chalk.gray(s);
}

function blankPane(w: number, h: number): string[] {
  return Array.from({ length: h }, (_, i) =>
    i === 0 ? chalk.gray("┌" + "─".repeat(Math.max(0, w - 2)) + "┐") : chalk.gray("│" + " ".repeat(Math.max(0, w - 2)) + "│")
  );
}

/** Split a buffer into wrapped lines and return the last `count` of them. */
function tailWrap(buffer: string, width: number, count: number): string[] {
  if (!buffer) return [];
  const raw = stripAnsi(buffer).replace(/\r/g, "");
  const out: string[] = [];
  for (const ln of raw.split("\n")) {
    if (ln.length === 0) {
      out.push("");
      continue;
    }
    for (let i = 0; i < ln.length; i += width) out.push(ln.slice(i, i + width));
  }
  return out.slice(-count);
}

/** Pad or truncate a PLAIN string to exactly `w` visible columns. */
function padTrunc(s: string, w: number): string {
  const plain = s.replace(/\n/g, " ");
  if (plain.length >= w) return plain.slice(0, w);
  return plain + " ".repeat(w - plain.length);
}

/** Truncate a possibly-colored string to `w` visible columns (best-effort). */
function truncVisible(s: string, w: number): string {
  return stripAnsi(s).length <= w ? s : stripAnsi(s).slice(0, w);
}

/** Left text + right text justified to width (right is ANSI-colored, measured plain). */
function padBetween(left: string, right: string, width: number): string {
  const lp = stripAnsi(left).length;
  const rp = stripAnsi(right).length;
  const space = Math.max(1, width - lp - rp);
  return left + " ".repeat(space) + right;
}

function stripToWidth(s: string, w: number, keepColor = false): string {
  const plain = stripAnsi(s);
  if (plain.length <= w) return s;
  return keepColor ? s.slice(0, w + (s.length - plain.length)) : plain.slice(0, w);
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function fmtElapsed(seconds: number): string {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}
