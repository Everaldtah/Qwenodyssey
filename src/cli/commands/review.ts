import chalk from "chalk";
import { createSession, GlobalOpts } from "../session";
import { loadPrompt, render } from "../../core/promptLoader";
import { extractJson } from "../../core/parse";

/**
 * Review the current uncommitted git diff (or a provided description).
 */
export async function reviewCommand(opts: GlobalOpts): Promise<void> {
  const s = createSession(opts);
  const diffRes = await s.tools.run("git_diff", {});
  if (!diffRes.ok) {
    console.log(chalk.yellow(diffRes.output));
    return;
  }
  const diff = diffRes.output;
  if (!diff || diff === "(no changes)") {
    console.log(chalk.gray("No uncommitted changes to review."));
    return;
  }

  console.log(chalk.cyan("→ ") + "Reviewing current diff…");
  const prompt = render(loadPrompt("reviewer"), {
    task: "Review the current uncommitted changes.",
    edits: "```diff\n" + diff.slice(0, 12000) + "\n```",
  });
  const res = await s.provider.generate(
    [
      { role: "system", content: loadPrompt("system") },
      { role: "user", content: prompt },
    ],
    { json: true, temperature: 0.1 }
  );
  const parsed = extractJson<any>(res.text);
  if (!parsed) {
    console.log(res.text);
    return;
  }
  console.log(
    chalk.bold("\nReview: ") +
      (parsed.approve !== false ? chalk.green("approved") : chalk.red("changes suggested")) +
      (parsed.summary ? chalk.gray(` — ${parsed.summary}`) : "")
  );
  for (const i of parsed.issues ?? []) {
    const tag =
      i.severity === "error" ? chalk.red("error") : i.severity === "warning" ? chalk.yellow("warn") : chalk.gray("info");
    console.log(`  [${tag}] ${i.file ? i.file + ": " : ""}${i.message}`);
  }
}
