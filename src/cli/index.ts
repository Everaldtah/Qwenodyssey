#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import type { AgentMode } from "../types";
import type { GlobalOpts } from "./session";
import { initCommand } from "./commands/init";
import { configCommand } from "./commands/config";
import { codeCommand } from "./commands/code";
import { editCommand } from "./commands/edit";
import { planCommand } from "./commands/plan";
import { reviewCommand } from "./commands/review";
import { testCommand } from "./commands/test";
import { applyCommand } from "./commands/apply";
import { memoryCommand } from "./commands/memory";
import { chatCommand } from "./commands/chat";

const program = new Command();

program
  .name("qwenodyssey")
  .description("An Odyssey-class coding harness for Qwen 2.5 7B.")
  .version("0.1.0")
  .option("--cwd <dir>", "project directory (default: current)")
  .option("--verbose", "verbose debug output")
  .option("-y, --yes", "auto-confirm all prompts");

/** Merge root options with a subcommand's options. */
function globals(cmd: Command, extra: Record<string, unknown> = {}): GlobalOpts {
  return { ...program.opts(), ...cmd.opts(), ...extra } as GlobalOpts;
}

function resolveMode(o: Record<string, unknown>): AgentMode | undefined {
  if (o.fast) return "fast";
  if (o.deep) return "deep";
  if (o.autofix) return "autofix";
  if (o.safe) return "safe";
  return undefined;
}

program
  .command("init")
  .description("Create a .qwenodyssey workspace in this project")
  .option("--force", "overwrite an existing config")
  .action((_o, cmd) => initCommand(globals(cmd, { force: cmd.opts().force })));

program
  .command("config")
  .description("Get/set/list configuration (config set model.model qwen2.5-coder:7b)")
  .argument("[action]", "get | set | list | path")
  .argument("[key]", "dotted key, e.g. model.provider")
  .argument("[value]", "value (for set)")
  .action((action, key, value, _o, cmd) => configCommand(action, key, value, globals(cmd)));

program
  .command("code")
  .description("Plan, edit, review, and test toward a task")
  .argument("<task>", "what you want done")
  .option("--fast", "minimal planning, direct edit")
  .option("--safe", "plan + review + confirm (default for small models)")
  .option("--deep", "plan + code + review + test + retry loop")
  .option("--autofix", "run tests, diagnose failures, patch, repeat")
  .action((task, _o, cmd) => codeCommand(task, globals(cmd, { mode: resolveMode(cmd.opts()) })));

program
  .command("edit")
  .description("Edit a single file with an instruction")
  .argument("<file>", "file to edit")
  .argument("<instruction>", "what to change")
  .action((file, instruction, _o, cmd) => editCommand(file, instruction, globals(cmd)));

program
  .command("plan")
  .description("Produce a step-by-step plan without editing")
  .argument("<goal>", "the goal to plan for")
  .action((goal, _o, cmd) => planCommand(goal, globals(cmd)));

program
  .command("review")
  .description("Review the current uncommitted git diff")
  .action((_o, cmd) => reviewCommand(globals(cmd)));

program
  .command("test")
  .description("Detect and run the project's test command")
  .action((_o, cmd) => testCommand(globals(cmd)));

program
  .command("apply")
  .description("Apply previously generated (pending) edits, or roll back the last patch")
  .option("--rollback", "roll back the most recent applied patch")
  .action((_o, cmd) => applyCommand(globals(cmd, { rollback: cmd.opts().rollback })));

program
  .command("memory")
  .description("Project memory: add | search | list | clear")
  .argument("[action]", "add | search | list | clear")
  .argument("[text]", "fact or query")
  .option("--category <cat>", "project | user | decisions | commands", "project")
  .action((action, text, _o, cmd) => memoryCommand(action, text, globals(cmd, { category: cmd.opts().category })));

program
  .command("chat")
  .description("Interactive pair-coding chat (streaming)")
  .action((_o, cmd) => chatCommand(globals(cmd)));

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red("Fatal: " + (err as Error).message));
  process.exit(1);
});
