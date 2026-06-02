import * as fs from "fs";
import * as readline from "readline";
import chalk from "chalk";
import { createSession, GlobalOpts } from "../session";
import { loadPrompt } from "../../core/promptLoader";
import { scanRepo, summarizeRepo } from "../../core/repoScanner";
import { resolveInside } from "../../tools/fileTools";
import type { Message } from "../../types";

/**
 * Interactive pair-coding chat. Streams responses. Type @path to inline a
 * file's contents, /reset to clear history, /exit to quit.
 */
export async function chatCommand(opts: GlobalOpts): Promise<void> {
  const s = createSession(opts);
  const health = await s.provider.healthCheck();
  if (!health.ok) {
    console.log(chalk.red(`Model backend not reachable: ${health.detail}`));
    process.exitCode = 1;
    return;
  }

  const repo = await scanRepo(s.cwd);
  const history: Message[] = [
    { role: "system", content: loadPrompt("system") + "\n\nPROJECT:\n" + summarizeRepo(repo) },
  ];

  console.log(chalk.bold("Qwenodyssey chat") + chalk.gray(`  (${s.provider.name}:${s.provider.model})`));
  console.log(chalk.gray("Type your message. @path inlines a file. /reset clears, /exit quits.\n"));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () =>
    new Promise<string>((resolve) => rl.question(chalk.cyan("you › "), resolve));

  for (;;) {
    const line = (await ask()).trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/reset") {
      history.length = 1;
      console.log(chalk.gray("(history cleared)\n"));
      continue;
    }

    const expanded = expandFileRefs(line, s.cwd);
    history.push({ role: "user", content: expanded });

    process.stdout.write(chalk.green("qwen › "));
    let full = "";
    try {
      const res = await s.provider.stream(
        history,
        (delta) => {
          full += delta;
          process.stdout.write(delta);
        },
        { temperature: s.config.model.temperature }
      );
      full = res.text || full;
    } catch (err) {
      console.log(chalk.red(`\n[error: ${(err as Error).message}]`));
      history.pop();
      continue;
    }
    process.stdout.write("\n\n");
    history.push({ role: "assistant", content: full });
  }
  rl.close();
}

function expandFileRefs(line: string, cwd: string): string {
  return line.replace(/@(\S+)/g, (match, p) => {
    try {
      const abs = resolveInside(cwd, p);
      if (fs.existsSync(abs)) {
        const content = fs.readFileSync(abs, "utf-8").slice(0, 6000);
        return `\n\n[file ${p}]\n\`\`\`\n${content}\n\`\`\`\n`;
      }
    } catch {
      /* leave as-is */
    }
    return match;
  });
}
