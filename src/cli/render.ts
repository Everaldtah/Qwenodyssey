/**
 * Terminal rendering helpers: diff coloring + lightweight markdown.
 */
import chalk from "chalk";

export interface BannerInfo {
  version: string;
  model: string;
  provider: string;
  mode: string;
  cwd: string;
}

/**
 * Claude-Code-style launch banner: a small block-glyph mark on the left with
 * version / model / cwd lines on the right, followed by an input hint divider.
 */
export function banner(info: BannerInfo): string {
  const mark = chalk.cyanBright;
  const dim = chalk.gray;
  const rows = [
    `${mark(" ▟█▜▛█▙ ")}  ${chalk.bold("Qwenodyssey")} ${dim("v" + info.version)}`,
    `${mark(" ▜█▟▙█▛ ")}  ${info.model} ${dim("· " + info.provider)}`,
    `${mark("  ▀▘▝▀  ")}  ${dim(info.cwd)}`,
  ];

  return [
    "",
    ...rows,
    dim(`\n   ${info.mode} mode · ${info.provider}:${info.model}`),
    dim(`   Type a message · @path inlines a file · Esc interrupts · /models · /help · /exit`),
    "",
  ].join("\n");
}

/** A full-width horizontal rule sized to the current terminal. */
export function hrule(): string {
  const width = Math.min((process.stdout.columns || 100) - 2, 120);
  return chalk.gray("─".repeat(Math.max(width, 40)));
}

/** Whimsical gerunds shown while the model is working (one per request). */
const THINKING_WORDS = [
  "Herding", "Pondering", "Noodling", "Conjuring", "Percolating", "Ruminating",
  "Synthesizing", "Cogitating", "Tinkering", "Brewing", "Scheming", "Musing",
  "Crunching", "Divining", "Untangling", "Marinating", "Spelunking", "Wrangling",
];

export function thinkingWord(): string {
  return THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
}

/** "9601" → "9.6k", "512" → "512", "12000" → "12k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

/** "85" → "1m 25s", "42" → "42s". */
export function formatElapsed(seconds: number): string {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

/**
 * A single-line LIVE status shown while the model generates, e.g.
 *   · Herding… (12s · ↑ 9.6k ↓ 47 tokens · 18 tok/s)
 * The leading glyph pulses, the elapsed time ticks, and the ↓ count climbs in
 * real time (1, 2, 3 …) as streamed deltas arrive via bumpOut()/setOut().
 * tok/s is the live generation rate measured from the first streamed token.
 * No-ops when stdout is not a TTY (piped output / tests), so it never pollutes
 * captured streams.
 */
export class Spinner {
  private timer?: ReturnType<typeof setInterval>;
  private startedAt = 0;
  private frame = 0;
  private paused = false;
  private outTokens = 0;
  private firstTokenAt = 0; // when streaming actually began (for tok/s)
  private lastDraw = 0;
  private static FRAMES = ["·", "∘", "○", "◌", "○", "∘"];
  private static MIN_REDRAW_MS = 60; // immediate-redraw throttle for token ticks

  constructor(private word: string, private upTokens: number) {}

  begin(): void {
    if (!process.stdout.isTTY) return;
    this.startedAt = Date.now();
    this.draw();
    this.timer = setInterval(() => this.draw(), 140);
    this.timer.unref?.();
  }

  /** Update the ↑ (input/context) count, e.g. once the prompt size is known. */
  setUp(tokens: number): void {
    this.upTokens = Math.max(0, Math.floor(tokens));
  }

  /** Add streamed output tokens — call this from the stream onChunk handler. */
  bumpOut(tokens = 1): void {
    if (this.outTokens === 0) this.firstTokenAt = Date.now();
    this.outTokens += Math.max(0, tokens);
    this.tickDraw();
  }

  /** Set the absolute streamed-output token count (alternative to bumpOut). */
  setOut(tokens: number): void {
    if (this.outTokens === 0 && tokens > 0) this.firstTokenAt = Date.now();
    this.outTokens = Math.max(0, Math.floor(tokens));
    this.tickDraw();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
  }

  /** Temporarily clear + halt the animation (e.g. while the user types an aside). */
  pause(): void {
    this.paused = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
  }

  /** Resume after pause() without resetting the elapsed clock. */
  resume(): void {
    this.paused = false;
    if (!process.stdout.isTTY || this.timer) return;
    this.draw();
    this.timer = setInterval(() => this.draw(), 140);
    this.timer.unref?.();
  }

  /** Live tok/s once streaming has begun; 0 until then. */
  private rate(): number {
    if (!this.firstTokenAt || this.outTokens < 2) return 0;
    const secs = (Date.now() - this.firstTokenAt) / 1000;
    return secs > 0.2 ? this.outTokens / secs : 0;
  }

  /** Redraw immediately on a token tick, throttled so fast streams stay cheap. */
  private tickDraw(): void {
    if (!process.stdout.isTTY || this.paused || !this.timer) return;
    const now = Date.now();
    if (now - this.lastDraw < Spinner.MIN_REDRAW_MS) return;
    this.draw();
  }

  private draw(): void {
    if (this.paused) return;
    this.lastDraw = Date.now();
    const secs = Math.floor((Date.now() - this.startedAt) / 1000);
    const glyph = Spinner.FRAMES[this.frame++ % Spinner.FRAMES.length];
    const r = this.rate();
    const parts = [
      formatElapsed(secs),
      `↑ ${formatTokens(this.upTokens)}` + (this.outTokens > 0 ? ` ↓ ${formatTokens(this.outTokens)}` : "") + " tokens",
    ];
    if (r > 0) parts.push(`${r >= 10 ? Math.round(r) : r.toFixed(1)} tok/s`);
    const line =
      chalk.magenta(glyph) +
      " " +
      chalk.magenta(this.word) +
      chalk.gray(`… (${parts.join(" · ")})`);
    process.stdout.write("\r\x1b[2K" + line);
  }
}

export function colorizeDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return chalk.bold(line);
      if (line.startsWith("@@")) return chalk.cyan(line);
      if (line.startsWith("+")) return chalk.green(line);
      if (line.startsWith("-")) return chalk.red(line);
      return chalk.gray(line);
    })
    .join("\n");
}

/**
 * Very small markdown renderer for the terminal: headings, bold, inline code,
 * and fenced code blocks. Avoids a heavy dependency.
 */
export function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const fence = line.match(/^```/);
    if (fence) {
      inFence = !inFence;
      out.push(chalk.gray(line));
      continue;
    }
    if (inFence) {
      out.push(chalk.yellow(line));
      continue;
    }
    let l = line;
    l = l.replace(/^(#{1,6})\s+(.*)$/, (_m, _h, t) => chalk.bold.underline(t));
    l = l.replace(/\*\*(.+?)\*\*/g, (_m, t) => chalk.bold(t));
    l = l.replace(/`([^`]+)`/g, (_m, t) => chalk.cyan(t));
    out.push(l);
  }
  return out.join("\n");
}
