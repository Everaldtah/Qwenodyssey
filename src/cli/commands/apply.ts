import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { createSession, GlobalOpts } from "../session";
import { workspacePath } from "../../core/config";
import { applyEdits, latestJournal, rollback } from "../../core/patchEngine";
import type { FileEdit } from "../../types";

function pendingFile(cwd: string): string {
  return path.join(workspacePath(cwd), "cache", "pending.json");
}

export function savePending(cwd: string, edits: FileEdit[]): void {
  const f = pendingFile(cwd);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ edits }, null, 2), "utf-8");
}

export async function applyCommand(opts: GlobalOpts & { rollback?: boolean }): Promise<void> {
  const s = createSession(opts);

  if (opts.rollback) {
    const journal = latestJournal(s.cwd);
    if (!journal) {
      console.log(chalk.yellow("No patch journal to roll back."));
      return;
    }
    const restored = rollback(s.cwd, journal);
    console.log(chalk.green(`✓ Rolled back ${restored.length} file(s) from ${path.basename(journal)}`));
    restored.forEach((r) => console.log("  - " + r));
    return;
  }

  const f = pendingFile(s.cwd);
  if (!fs.existsSync(f)) {
    console.log(chalk.yellow("No pending edits. Generate some with `qwenodyssey code \"…\"` first."));
    return;
  }
  const { edits } = JSON.parse(fs.readFileSync(f, "utf-8")) as { edits: FileEdit[] };
  const outcome = applyEdits(s.cwd, edits);
  outcome.applied.forEach((a) =>
    a.ok ? console.log(chalk.green(`✓ ${a.mode} ${a.path}`)) : console.log(chalk.red(`✗ ${a.path}: ${a.error}`))
  );
  fs.rmSync(f);
}
