/**
 * Terminal rendering helpers: diff coloring + lightweight markdown.
 */
import chalk from "chalk";

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
