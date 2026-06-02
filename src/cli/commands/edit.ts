import * as fs from "fs";
import chalk from "chalk";
import prompts from "prompts";
import { createSession, GlobalOpts } from "../session";
import { scanRepo } from "../../core/repoScanner";
import { buildContext } from "../../core/contextBuilder";
import { code as codeAgent } from "../../agents/coder";
import { applyEdits, previewEdit } from "../../core/patchEngine";
import { resolveInside } from "../../tools/fileTools";
import { colorizeDiff } from "../render";

export async function editCommand(file: string, instruction: string, opts: GlobalOpts): Promise<void> {
  if (!file || !instruction) {
    console.log(chalk.red('Usage: qwenodyssey edit <file> "instruction"'));
    process.exitCode = 1;
    return;
  }
  const s = createSession(opts);
  const abs = resolveInside(s.cwd, file);
  if (!fs.existsSync(abs)) {
    console.log(chalk.red(`Not found: ${file}`));
    process.exitCode = 1;
    return;
  }

  s.logger.start(`edit ${file}: ${instruction}`);
  const repo = await scanRepo(s.cwd);
  const task = `Edit the file "${file}". Instruction: ${instruction}`;
  const context = buildContext(s.provider, {
    userRequest: task,
    repo,
    files: [file],
    budgetTokens: Math.floor(s.config.model.context_tokens * 0.6),
  });

  console.log(chalk.cyan("→ ") + "Generating edit…");
  const out = await codeAgent(s.provider, task, { goal: task, steps: [{ index: 1, title: instruction }], files: [file] }, context);
  if (out.edits.length === 0) {
    console.log(chalk.yellow("No edit produced."));
    return;
  }
  for (const e of out.edits) {
    console.log(chalk.bold(`\n${e.mode.toUpperCase()} ${e.path}`));
    console.log(colorizeDiff(previewEdit(s.cwd, e)));
  }

  const go = s.autoConfirm || s.config.agent.auto_apply || (await prompts({ type: "confirm", name: "go", message: "Apply?", initial: true })).go;
  if (!go) {
    console.log(chalk.gray("Not applied."));
    return;
  }
  const outcome = applyEdits(s.cwd, out.edits);
  outcome.applied.forEach((a) =>
    a.ok ? console.log(chalk.green(`✓ ${a.mode} ${a.path}`)) : console.log(chalk.red(`✗ ${a.path}: ${a.error}`))
  );
}
