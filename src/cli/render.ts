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
  const width = Math.min((process.stdout.columns || 100) - 2, 120);
  const rule = dim("─".repeat(Math.max(width, 40)));

  const rows = [
    `${mark(" ▟█▜▛█▙ ")}  ${chalk.bold("Qwenodyssey")} ${dim("v" + info.version)}`,
    `${mark(" ▜█▟▙█▛ ")}  ${info.model} ${dim("· " + info.provider)}`,
    `${mark("  ▀▘▝▀  ")}  ${dim(info.cwd)}`,
  ];

  const hint =
    `${chalk.cyan("❯")} ${dim('Type your message. @path inlines a file. /models to switch · /help · /exit')}`;

  return [
    "",
    ...rows,
    dim(`\n   ${info.mode} mode · ${info.provider}:${info.model} · /exit to quit`),
    "",
    rule,
    hint,
    rule,
    "",
  ].join("\n");
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
