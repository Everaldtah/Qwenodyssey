import chalk from "chalk";
import { createSession, GlobalOpts } from "../session";
import { scanRepo } from "../../core/repoScanner";
import { runTests } from "../../agents/tester";

export async function testCommand(opts: GlobalOpts): Promise<void> {
  const s = createSession(opts);
  const repo = await scanRepo(s.cwd);
  if (!repo.testCommand) {
    console.log(chalk.yellow("No test command detected for this project."));
    console.log(chalk.gray("Detected languages: " + repo.languages.join(", ")));
    return;
  }
  console.log(chalk.cyan("→ ") + `Running: ${repo.testCommand}`);
  const result = await runTests(s.tools, repo);
  console.log(result.output);
  if (result.passed) console.log(chalk.green("✓ Tests passed."));
  else {
    console.log(chalk.red("✗ Tests failed."));
    process.exitCode = 1;
  }
}
