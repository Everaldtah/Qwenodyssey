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
    dim(`   Type a message · @path inlines a file · /models · /help · /exit`),
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
 * A single-line live status shown while the model generates, e.g.
 *   · Herding… (5m 25s · ↑ 9.6k tokens)
 * The leading glyph pulses and the elapsed time ticks; the token count is the
 * estimated input/context size sent up for this request. No-ops when stdout is
 * not a TTY (piped output / tests), so it never pollutes captured streams.
 */
export class Spinner {
  private timer?: ReturnType<typeof setInterval>;
  private startedAt = 0;
  private frame = 0;
  private static FRAMES = ["·", "∘", "○", "◌", "○", "∘"];

  constructor(private word: string, private upTokens: number) {}

  begin(): void {
    if (!process.stdout.isTTY) return;
    this.startedAt = Date.now();
    this.draw();
    this.timer = setInterval(() => this.draw(), 140);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
  }

  private draw(): void {
    const secs = Math.floor((Date.now() - this.startedAt) / 1000);
    const glyph = Spinner.FRAMES[this.frame++ % Spinner.FRAMES.length];
    const line =
      chalk.magenta(glyph) +
      " " +
      chalk.magenta(this.word) +
      chalk.gray(`… (${formatElapsed(secs)} · ↑ ${formatTokens(this.upTokens)} tokens)`);
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
