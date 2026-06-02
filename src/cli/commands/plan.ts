import chalk from "chalk";
import { createSession, GlobalOpts } from "../session";
import { scanRepo } from "../../core/repoScanner";
import { plan as planAgent } from "../../agents/planner";

export async function planCommand(goal: string, opts: GlobalOpts): Promise<void> {
  if (!goal) {
    console.log(chalk.red('Usage: qwenodyssey plan "goal"'));
    process.exitCode = 1;
    return;
  }
  const s = createSession(opts);
  const repo = await scanRepo(s.cwd);
  const files = (await s.tools.run("list_files", { pattern: "**/*" })).data as string[];
  console.log(chalk.cyan("→ ") + "Planning…");
  const plan = await planAgent(s.provider, goal, repo, files ?? []);

  console.log(chalk.bold("\nGoal: ") + plan.goal);
  if (plan.files.length) {
    console.log(chalk.bold("Files:"));
    plan.files.forEach((f) => console.log("  - " + f));
  }
  console.log(chalk.bold("Steps:"));
  plan.steps.forEach((st) =>
    console.log(`  ${st.index}. ${st.title}` + (st.detail ? chalk.gray(` — ${st.detail}`) : ""))
  );
  if (plan.assumptions?.length) {
    console.log(chalk.yellow("Assumptions:"));
    plan.assumptions.forEach((a) => console.log("  · " + a));
  }
}
