import type { FileEdit, Provider, ReviewResult } from "../types";
import { loadPrompt, render } from "../core/promptLoader";
import { extractJson } from "../core/parse";
import { previewEdit } from "../core/patchEngine";

export async function review(
  provider: Provider,
  cwd: string,
  task: string,
  edits: FileEdit[]
): Promise<ReviewResult> {
  const diffs = edits
    .map((e) => `### ${e.path} (${e.mode})\n\`\`\`diff\n${previewEdit(cwd, e)}\n\`\`\``)
    .join("\n\n");
  const prompt = render(loadPrompt("reviewer"), { task, edits: diffs });
  const res = await provider.generate(
    [
      { role: "system", content: loadPrompt("system") },
      { role: "user", content: prompt },
    ],
    { json: true, temperature: 0.1 }
  );
  const parsed = extractJson<any>(res.text);
  if (!parsed) {
    // If the reviewer is unparseable, do not block — flag it as a warning.
    return {
      approve: true,
      issues: [{ severity: "warning", message: "reviewer output was unstructured" }],
      summary: "review skipped (unparseable)",
    };
  }
  return {
    approve: parsed.approve !== false,
    summary: parsed.summary,
    issues: Array.isArray(parsed.issues)
      ? parsed.issues.map((i: any) => ({
          severity: ["info", "warning", "error"].includes(i.severity) ? i.severity : "info",
          file: i.file,
          message: String(i.message ?? ""),
        }))
      : [],
  };
}
