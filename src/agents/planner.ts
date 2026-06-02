import type { Plan, Provider, RepoInfo } from "../types";
import { loadPrompt, render } from "../core/promptLoader";
import { extractJson } from "../core/parse";
import { summarizeRepo } from "../core/repoScanner";

export async function plan(
  provider: Provider,
  task: string,
  repo: RepoInfo,
  fileList: string[]
): Promise<Plan> {
  const prompt = render(loadPrompt("planner"), {
    task,
    repo: summarizeRepo(repo),
    files: fileList.slice(0, 60).join("\n"),
  });
  const res = await provider.generate(
    [
      { role: "system", content: loadPrompt("system") },
      { role: "user", content: prompt },
    ],
    { json: true, temperature: 0.1 }
  );
  const parsed = extractJson<any>(res.text);
  if (!parsed || !Array.isArray(parsed.steps)) {
    // Fallback: a single-step plan so the pipeline can still proceed.
    return {
      goal: task,
      steps: [{ index: 1, title: task, detail: task }],
      files: [],
      assumptions: ["planner output was unstructured; using a single-step plan"],
    };
  }
  return {
    goal: parsed.goal || task,
    files: Array.isArray(parsed.files) ? parsed.files : [],
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
    steps: parsed.steps.map((s: any, i: number) => ({
      index: s.index ?? i + 1,
      title: s.title ?? `step ${i + 1}`,
      detail: s.detail,
      files: Array.isArray(s.files) ? s.files : undefined,
    })),
  };
}
