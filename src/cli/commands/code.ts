import chalk from "chalk";
import { createSession, GlobalOpts } from "../session";
import { Orchestrator } from "../../core/orchestrator";
import { renderMarkdown } from "../render";
import { savePending } from "./apply";

export async function codeCommand(task: string, opts: GlobalOpts): Promise<void> {
  if (!task || !task.trim()) {
    console.log(chalk.red('Usage: qwenodyssey code "describe the task"'));
    process.exitCode = 1;
    return;
  }
  const s = createSession(opts);

  const health = await s.provider.healthCheck();
  if (!health.ok) {
    console.log(chalk.red(`Model backend not reachable (${s.provider.name}): ${health.detail}`));
    console.log(chalk.gray("Check your config: qwenodyssey config list"));
    process.exitCode = 1;
    return;
  }
  if (health.detail) console.log(chalk.yellow(`! ${health.detail}`));

  const orch = new Orchestrator(s.cwd, s.provider, s.config, s.tools, s.logger, s.memory);
  const result =
    s.mode === "autofix"
      ? await orch.runAutofix(task)
      : await orch.runCode(task, { mode: s.mode, autoConfirm: s.autoConfirm });

  // If edits were generated but not applied, stash them so `apply` can finish.
  if (!result.applied && result.edits.length > 0) {
    savePending(s.cwd, result.edits);
    console.log(chalk.gray("Pending edits saved — run `qwenodyssey apply` to write them."));
  }

  console.log(chalk.bold("\n── Summary ──"));
  console.log(renderMarkdown(result.summary));
  if (s.logger.logFile) console.log(chalk.gray(`\nLog: ${s.logger.logFile}`));
}
