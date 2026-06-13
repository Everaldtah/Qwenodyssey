/**
 * Live split-pane TUI for the coordinated swarm.
 *
 * - One fully-boxed pane per agent (2×N grid) + a full-width SYNTHESIZER pane that
 *   shows the final integrated result, so the deliverable lives on the lead model's
 *   screen rather than being dumped raw to the terminal.
 * - Each pane is a mini Qwenodyssey dashboard (logo + model · backend + cwd) with a
 *   live token counter on its bottom border (↑ prompt ↓ completion · tok/s).
 * - The panes STAY UP when the run finishes (alt-screen review mode); you can focus
 *   any pane (Tab / 1-5) and scroll its full session history (↑/↓, PgUp/PgDn, g/G),
 *   then press q to leave. Nothing is printed raw to the scrollback.
 *
 * Dependency-free: raw ANSI + chalk. TTY-gated — when stdout is not a TTY, start()
 * is a no-op and the caller falls back to a plain line logger.
 */
import chalk from "chalk";
import {
  cleanAgentText,
  type SwarmEvents,
  type PlanEvent,
  type AssignEvent,
  type DeltaEvent,
  type StatusEvent,
  type WaveEvent,
  type SubtaskStatus,
  type CoordinatedResult,
} from "../core/swarmCoordinator";
import type { SwarmRun, SwarmArtifacts } from "../core/swarm";

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const HOME = "\x1b[H";
const CLEAR_EOL = "\x1b[K";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** The Qwenodyssey block-glyph mark (3 rows), shared with the launch banner. */
const MARK = [" ▟█▜▛█▙ ", " ▜█▟▙█▛ ", "  ▀▘▝▀  "];
const MAX_BUFFER = 200_000; // per-pane scrollback cap (chars)

const VERSION: string = (() => {
  try {
    return require("../../package.json").version || "0.3.0";
  } catch {
    return "0.3.0";
  }
})();

export interface RosterEntry {
  label: string;
  model?: string;
  backend?: string;
}

type PaneKind = "agent" | "synth";

interface PaneState {
  kind: PaneKind;
  subtaskId?: string;
  title: string;
  model: string;
  fullModel?: string;
  backend?: string;
  status: SubtaskStatus | "idle";
  buffer: string;
  startedAt: number;
  ms?: number;
  // token accounting
  outChars: number;
  firstTokenAt: number;
  upTokens?: number;
  outTokens?: number; // exact completion tokens once known
  // scrolling
  scrollOffset: number; // lines from the bottom; 0 = follow tail
  // wrap cache
  _cacheW?: number;
  _cacheLen?: number;
  _cacheLines?: string[];
}

export interface SwarmTuiOptions {
  task: string;
  panes: number;
  note?: string;
  roster?: RosterEntry[];
  cwd?: string;
  /** Called when the user requests abort (Ctrl-C/q) while the run is still going. */
  onAbort?: () => void;
}

export class SwarmTui {
  private panes: PaneState[];
  private synth: PaneState;
  private timer?: ReturnType<typeof setInterval>;
  private startedAt = 0;
  private frame = 0;
  private waveIndex = 0;
  private subtaskCount = 0;
  private doneCount = 0;
  private failCount = 0;
  private running = false;
  private phase: "planning" | "running" | "complete" = "planning";
  private planningWith?: string;
  private planNote?: string;
  private planned = false;
  private execLabel?: string;
  private artifacts?: SwarmArtifacts;
  /** Focused pane index; this.panes.length === the synth pane. */
  private focus = 0;
  private quitRequested = false;
  private exitResolve?: () => void;
  private onKey?: (d: string) => void;
  private readonly out = process.stdout;

  constructor(private events: SwarmEvents, private opts: SwarmTuiOptions) {
    const mk = (kind: PaneKind, r?: RosterEntry): PaneState => ({
      kind,
      title: "",
      model: r?.label ?? "",
      fullModel: r?.model ?? r?.label,
      backend: r?.backend,
      status: "idle",
      buffer: "",
      startedAt: 0,
      outChars: 0,
      firstTokenAt: 0,
      scrollOffset: 0,
    });
    this.panes = Array.from({ length: Math.max(1, opts.panes) }, (_, i) => mk("agent", opts.roster?.[i]));
    this.synth = mk("synth");
    this.synth.title = "results";
  }

  static supported(): boolean {
    return !!process.stdout.isTTY && (process.stdout.columns ?? 0) >= 40;
  }

  start(): void {
    if (!SwarmTui.supported()) return;
    this.running = true;
    this.phase = "planning";
    this.startedAt = Date.now();
    this.wire();
    this.attachKeys();
    this.out.write(ALT_SCREEN_ON + HIDE_CURSOR + "\x1b[2J\x1b[H");
    this.draw();
    this.timer = setInterval(() => this.draw(), 100);
    this.timer.unref?.();
  }

  /** Mark the run finished and surface the final output + files on the RESULTS pane. */
  complete(run: SwarmRun): void {
    this.phase = "complete";
    this.synth.status = run.results.some((r) => r.ok) ? "done" : "failed";
    this.synth.model = run.synthesizedBy || this.synth.model || "results";
    this.synth.fullModel = run.synthesizedBy || this.synth.fullModel;
    if (run.artifacts) this.artifacts = run.artifacts;

    const okResults = (run.results as CoordinatedResult[]).filter((r) => r.ok);
    const out =
      run.synthesis ||
      (okResults.length ? okResults.map((r) => `## ${r.title}\n${r.text}`).join("\n\n") : "All agents failed — no result.");

    const parts = [out];
    const arts = this.artifacts;
    if (arts && arts.files.length) {
      parts.push(
        "\n\n──────── Files generated ────────\n" +
          `Location: ${arts.location}\n` +
          arts.files.map((f) => `  • ${f}`).join("\n")
      );
    } else if (arts) {
      parts.push(`\n\n──────── Files generated ────────\nLocation: ${arts.location}\n  (no new files detected)`);
    }
    this.synth.buffer = parts.join("");
    this.invalidate(this.synth);
    this.focus = this.panes.length; // focus the results pane
    this.synth.scrollOffset = Number.MAX_SAFE_INTEGER; // show it from the top
    if (this.running) this.draw();
  }

  /** Resolves when the user leaves review mode (q / Ctrl-C), or immediately if no TTY. */
  waitForExit(): Promise<void> {
    if (this.quitRequested || !process.stdin.isTTY) return Promise.resolve();
    return new Promise((res) => (this.exitResolve = res));
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.detachKeys();
    this.out.write(SHOW_CURSOR + ALT_SCREEN_OFF);
  }

  /** The final integrated result text (for the caller to persist to a file). */
  finalResult(): string {
    return this.synth.buffer;
  }

  /* ── keyboard ── */

  private attachKeys(): void {
    const stdin = process.stdin;
    if (!stdin.isTTY) return;
    try {
      stdin.setRawMode(true);
    } catch {
      /* ignore */
    }
    stdin.resume();
    stdin.setEncoding("utf8");
    this.onKey = (d: string) => this.handleKey(d);
    stdin.on("data", this.onKey);
  }

  private detachKeys(): void {
    const stdin = process.stdin;
    if (this.onKey) stdin.removeListener("data", this.onKey);
    this.onKey = undefined;
    if (stdin.isTTY) {
      try {
        stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
    stdin.pause();
  }

  private quit(): void {
    this.quitRequested = true;
    if (this.phase !== "complete") this.opts.onAbort?.();
    this.exitResolve?.();
    this.exitResolve = undefined;
  }

  private focusPanes(): PaneState[] {
    return [...this.panes, this.synth];
  }

  private handleKey(d: string): void {
    const all = this.focusPanes();
    const cur = all[Math.min(this.focus, all.length - 1)];
    const bodyRows = 6; // approximate page size; exact rows vary, this is fine for paging
    switch (d) {
      case "q":
      case "Q":
      case "\x03": // Ctrl-C
        this.quit();
        return;
      case "\t": // Tab
        this.focus = (this.focus + 1) % all.length;
        break;
      case "\x1b[Z": // Shift-Tab
        this.focus = (this.focus - 1 + all.length) % all.length;
        break;
      case "\x1b[A": // Up
      case "k":
        cur.scrollOffset += 1;
        break;
      case "\x1b[B": // Down
      case "j":
        cur.scrollOffset = Math.max(0, cur.scrollOffset - 1);
        break;
      case "\x1b[5~": // PgUp
        cur.scrollOffset += bodyRows;
        break;
      case "\x1b[6~": // PgDn
        cur.scrollOffset = Math.max(0, cur.scrollOffset - bodyRows);
        break;
      case "g":
      case "\x1b[H": // Home
        cur.scrollOffset = Number.MAX_SAFE_INTEGER;
        break;
      case "G":
      case "\x1b[F": // End
        cur.scrollOffset = 0;
        break;
      default:
        if (/^[1-9]$/.test(d)) {
          const idx = parseInt(d, 10) - 1;
          if (idx < all.length) this.focus = idx;
        } else {
          return; // unknown key, no redraw
        }
    }
    if (this.running) this.draw();
  }

  /* ── event wiring ── */

  private invalidate(p: PaneState): void {
    p._cacheLines = undefined;
  }

  private wire(): void {
    this.events.on("planner", (e: { model: string }) => {
      this.planningWith = e.model;
    });
    this.events.on("plan", (e: PlanEvent) => {
      this.subtaskCount = e.subtasks.length;
      this.planningWith = undefined;
      this.planned = true;
      this.phase = "running";
      if (e.exec) this.execLabel = e.exec;
      if (e.note) this.planNote = e.note;
      e.roster.forEach((r, i) => {
        const p = this.panes[i];
        if (!p) return;
        p.model = r.label;
        p.fullModel = r.model || r.label;
        p.backend = r.backend;
      });
    });
    this.events.on("wave", (e: WaveEvent) => (this.waveIndex = e.index));
    this.events.on("assign", (e: AssignEvent) => {
      const p = this.panes[e.pane % this.panes.length];
      p.subtaskId = e.subtaskId;
      p.title = e.title;
      p.model = e.workerLabel || p.model;
      p.fullModel = e.model || p.fullModel;
      p.status = "running";
      p.buffer = "";
      p.outChars = 0;
      p.firstTokenAt = 0;
      p.outTokens = undefined;
      p.upTokens = undefined;
      p.scrollOffset = 0;
      p.startedAt = Date.now();
      p.ms = undefined;
      this.invalidate(p);
    });
    this.events.on("delta", (e: DeltaEvent) => {
      const p = this.panes[e.pane % this.panes.length];
      this.appendDelta(p, e.delta);
    });
    this.events.on("status", (e: StatusEvent) => {
      const p = this.panes[e.pane % this.panes.length];
      p.status = e.status;
      if (e.ms != null) p.ms = e.ms;
      if (e.status === "done") this.doneCount++;
      if (e.status === "failed") this.failCount++;
    });
    this.events.on("result", (r: CoordinatedResult) => {
      const p = this.panes.find((x) => x.subtaskId === r.id);
      if (!p) return;
      if (r.promptTokens != null) p.upTokens = r.promptTokens;
      if (r.completionTokens != null) p.outTokens = r.completionTokens;
    });
    this.events.on("synth", (e: { model: string }) => {
      this.synth.status = "running";
      this.synth.model = e.model;
      this.synth.fullModel = e.model;
      this.synth.startedAt = Date.now();
      this.synth.buffer = "";
      this.synth.outChars = 0;
      this.synth.firstTokenAt = 0;
      this.invalidate(this.synth);
    });
    this.events.on("synthDelta", (e: { delta: string }) => this.appendDelta(this.synth, e.delta));
    this.events.on("artifacts", (a: SwarmArtifacts) => (this.artifacts = a));
  }

  private appendDelta(p: PaneState, delta: string): void {
    if (p.outChars === 0) p.firstTokenAt = Date.now();
    p.buffer += delta;
    p.outChars += delta.length;
    if (p.buffer.length > MAX_BUFFER) p.buffer = p.buffer.slice(-MAX_BUFFER);
    this.invalidate(p);
  }

  /* ── rendering ── */

  private draw(): void {
    if (!this.running) return;
    this.frame++;
    const width = this.out.columns || 80;
    const height = this.out.rows || 24;
    const all = this.focusPanes();
    const lines: string[] = [this.header(width)];

    const n = this.panes.length;
    const cols = Math.max(1, Math.min(n, Math.floor(width / 24) || 1, Math.ceil(Math.sqrt(n))));
    const gridRows = Math.ceil(n / cols);
    const gap = 1;
    const paneW = Math.max(20, Math.floor((width - gap * (cols - 1)) / cols));
    const fullW = paneW * cols + gap * (cols - 1);

    const avail = Math.max(8, height - 2); // minus header + footer
    const synthH = Math.max(4, Math.min(avail - gridRows * 3, Math.floor(avail * 0.32)));
    const gridArea = avail - synthH;
    const paneH = Math.max(3, Math.floor(gridArea / gridRows));

    // Agent grid.
    for (let r = 0; r < gridRows; r++) {
      const rowBoxes: string[][] = [];
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        rowBoxes.push(
          idx < n ? this.renderBox(this.panes[idx], paneW, paneH, this.focus === idx) : blankBox(paneW, paneH)
        );
      }
      for (let k = 0; k < paneH; k++) lines.push(rowBoxes.map((b) => b[k]).join(" ".repeat(gap)));
    }

    // Synthesizer pane (full width).
    const synthBox = this.renderBox(this.synth, fullW, synthH, this.focus === n);
    for (const l of synthBox) lines.push(l);

    lines.push(this.footer(width));

    const visible = lines.slice(0, height);
    this.out.write(HOME + visible.map((l) => l + CLEAR_EOL).join("\r\n"));
  }

  private header(width: number): string {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const left = chalk.bold("🜂 swarm") + chalk.gray(`  ${this.opts.task}`);
    const phase =
      this.phase === "complete"
        ? chalk.green("✓ complete")
        : this.planned
          ? `wave ${this.waveIndex + 1}`
          : `${SPIN[this.frame % SPIN.length]} planning split` +
            (this.planningWith ? ` with ${this.planningWith}` : "") +
            "…";
    const right = chalk.gray(`${phase} · ${fmtElapsed(elapsed)}`);
    return padBetween(stripToWidth(left, width - stripAnsi(right).length - 1, true), right, width);
  }

  private footer(width: number): string {
    const notes = [this.opts.note, this.planNote].filter(Boolean).join(" · ");
    const note = notes ? chalk.yellow(` ⚠ ${notes}`) : "";
    const exec = this.execLabel ? chalk.cyan(` · exec: ${this.execLabel}`) : "";
    const fails = this.failCount ? chalk.red(` · ${this.failCount} failed`) : "";
    const prog = chalk.gray(`${this.doneCount}/${this.subtaskCount || this.panes.length} done`);
    const keys =
      this.phase === "complete"
        ? chalk.gray("   ") + chalk.cyan("Tab") + chalk.gray(" focus · ") + chalk.cyan("↑↓/PgUp/PgDn/g/G") + chalk.gray(" scroll · ") + chalk.cyan("q") + chalk.gray(" quit")
        : chalk.gray("   Tab focus · ↑↓ scroll · Ctrl-C abort");
    return truncVisible(prog + fails + exec + note + keys, width);
  }

  /** Render one fully-boxed pane: exactly `w`×`h`, each line `w` visible columns. */
  private renderBox(p: PaneState, w: number, h: number, focused: boolean): string[] {
    const bc = focused ? chalk.cyanBright : chalk.gray;
    const inner = w - 2;
    const lines: string[] = [bc("┌") + this.titleBar(p, inner) + bc("┐")];

    let bodyRows = h - 2; // minus top + bottom borders
    // Per-agent Qwenodyssey dashboard when tall enough.
    if (p.kind === "agent" && bodyRows >= MARK.length + 2) {
      for (const dl of this.paneDashboard(p, inner)) lines.push(bc("│") + dl + bc("│"));
      lines.push(bc("├") + bc("─".repeat(inner)) + bc("┤"));
      bodyRows -= MARK.length + 1;
    }

    const wrapped = this.wrappedLines(p, inner);
    const total = wrapped.length;
    const maxOff = Math.max(0, total - bodyRows);
    if (p.scrollOffset > maxOff) p.scrollOffset = maxOff;
    const end = total - p.scrollOffset;
    const start = Math.max(0, end - bodyRows);
    const windowLines = wrapped.slice(start, end);
    for (let i = 0; i < bodyRows; i++) {
      lines.push(bc("│") + chalk.dim(padTrunc(windowLines[i] ?? "", inner)) + bc("│"));
    }

    lines.push(bc("└") + this.bottomBar(p, inner, start > 0, p.scrollOffset > 0) + bc("┘"));
    return lines;
  }

  private titleBar(p: PaneState, inner: number): string {
    const glyph = statusGlyph(p.status, this.frame);
    const elapsed =
      p.status === "running" && p.startedAt
        ? fmtElapsed(Math.floor((Date.now() - p.startedAt) / 1000))
        : p.ms != null
          ? fmtElapsed(Math.round(p.ms / 1000))
          : "";
    const name =
      p.kind === "synth"
        ? `📋 results${this.phase === "complete" ? "" : this.synth.status === "running" ? " · compiling" : " · waiting"}${p.model ? " · " + p.model : ""}`
        : p.model || "—";
    const titlePlain = ` ${stripAnsi(glyph)} ${name}${p.title && p.kind === "agent" ? " · " + p.title : ""} `;
    const elapTag = elapsed ? `${elapsed} ` : "";
    const titleFit = padTrunc(titlePlain.replace(/\s+$/, ""), Math.max(0, inner - elapTag.length));
    return colorTitle(titleFit, p.status) + chalk.gray(elapTag);
  }

  /** Bottom border carries the live token counter + a scroll indicator. */
  private bottomBar(p: PaneState, inner: number, moreAbove: boolean, scrolledUp: boolean): string {
    const up = p.upTokens != null ? `↑ ${fmtTok(p.upTokens)} ` : "";
    const outTok = p.outTokens != null ? p.outTokens : Math.ceil(p.outChars / 4);
    const down = outTok > 0 || p.status !== "idle" ? `↓ ${fmtTok(outTok)} ` : "";
    let rate = 0;
    if (p.firstTokenAt && p.status === "running") {
      const secs = (Date.now() - p.firstTokenAt) / 1000;
      if (secs > 0.3) rate = outTok / secs;
    }
    const rateTag = rate > 0 ? `· ${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} tok/s ` : "";
    const left = `─ ${up}${down}${rateTag}`;
    const scroll = scrolledUp ? ` ⇡scroll ` : moreAbove ? ` ▲more ` : "";
    const leftVis = stripAnsi(left).length;
    const rightVis = scroll.length;
    const fill = Math.max(0, inner - leftVis - rightVis);
    return chalk.gray(left) + chalk.gray("─".repeat(fill)) + chalk.yellow(scroll);
  }

  private paneDashboard(p: PaneState, inner: number): string[] {
    const model = p.fullModel || p.model || "—";
    const backend = p.backend ? chalk.gray(` · ${p.backend}`) : "";
    const texts = [
      chalk.bold("Qwenodyssey") + " " + chalk.gray("v" + VERSION),
      chalk.white(model) + backend,
      chalk.gray(this.opts.cwd ?? process.cwd()),
    ];
    return MARK.map((m, i) => fitColored(chalk.cyanBright(m) + "  " + texts[i], inner));
  }

  /** Cleaned + wrapped lines for a pane's full buffer (cached per width/length). */
  private wrappedLines(p: PaneState, inner: number): string[] {
    if (p._cacheLines && p._cacheW === inner && p._cacheLen === p.buffer.length) return p._cacheLines;
    const cleaned = cleanAgentText(p.buffer);
    const lines = wrapAll(cleaned, inner);
    p._cacheLines = lines;
    p._cacheW = inner;
    p._cacheLen = p.buffer.length;
    return lines;
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

function blankBox(w: number, h: number): string[] {
  const top = chalk.gray("┌" + "─".repeat(Math.max(0, w - 2)) + "┐");
  const mid = chalk.gray("│" + " ".repeat(Math.max(0, w - 2)) + "│");
  const bot = chalk.gray("└" + "─".repeat(Math.max(0, w - 2)) + "┘");
  return [top, ...Array.from({ length: Math.max(0, h - 2) }, () => mid), bot];
}

/** Wrap a multi-line string to `width`, returning ALL visual lines. */
function wrapAll(text: string, width: number): string[] {
  if (!text || width < 1) return [];
  const raw = text.replace(/\r/g, "");
  const out: string[] = [];
  for (const ln of raw.split("\n")) {
    if (ln.length === 0) {
      out.push("");
      continue;
    }
    for (let i = 0; i < ln.length; i += width) out.push(ln.slice(i, i + width));
  }
  return out;
}

function padTrunc(s: string, w: number): string {
  const plain = s.replace(/\n/g, " ");
  if (plain.length >= w) return plain.slice(0, w);
  return plain + " ".repeat(w - plain.length);
}

function truncVisible(s: string, w: number): string {
  return stripAnsi(s).length <= w ? s : stripAnsi(s).slice(0, w);
}

function fitColored(s: string, w: number): string {
  const vis = stripAnsi(s).length;
  if (vis === w) return s;
  if (vis < w) return s + " ".repeat(w - vis);
  return stripAnsi(s).slice(0, w);
}

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

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}
