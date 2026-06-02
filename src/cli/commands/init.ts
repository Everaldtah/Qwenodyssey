import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { configPath, defaultConfig, saveConfig, workspacePath } from "../../core/config";
import type { GlobalOpts } from "../session";

export async function initCommand(opts: GlobalOpts & { force?: boolean }): Promise<void> {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const ws = workspacePath(cwd);
  const cfgFile = configPath(cwd);

  if (fs.existsSync(cfgFile) && !opts.force) {
    console.log(chalk.yellow(`${cfgFile} already exists. Use --force to overwrite.`));
    return;
  }

  // Create workspace layout
  for (const sub of ["memory", "patches", "logs", "cache"]) {
    fs.mkdirSync(path.join(ws, sub), { recursive: true });
  }
  saveConfig(cwd, defaultConfig());

  // Seed memory files
  const memDir = path.join(ws, "memory");
  for (const [f, header] of [
    ["project.md", "# Project memory\n"],
    ["user.md", "# User preferences\n"],
    ["decisions.md", "# Architecture decisions\n"],
    ["commands.md", "# Useful commands\n"],
  ] as const) {
    const fp = path.join(memDir, f);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, header, "utf-8");
  }

  console.log(chalk.green("✓ Initialized Qwenodyssey workspace"));
  console.log(`  Config: ${chalk.cyan(cfgFile)}`);
  console.log("\nNext steps:");
  console.log(chalk.gray("  qwenodyssey config set model.provider ollama"));
  console.log(chalk.gray("  qwenodyssey config set model.model qwen2.5:7b"));
  console.log(chalk.gray('  qwenodyssey code "your first task"'));
}
