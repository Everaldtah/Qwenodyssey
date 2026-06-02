import type { CoderResult, FileEdit, Plan, Provider } from "../types";
import { loadPrompt, render } from "../core/promptLoader";
import { extractJson } from "../core/parse";

function normalizeEdits(raw: any): FileEdit[] {
  if (!raw || !Array.isArray(raw.edits)) return [];
  return raw.edits
    .filter((e: any) => e && typeof e.path === "string")
    .map((e: any) => ({
      path: e.path,
      mode: ["patch", "create", "rewrite", "delete"].includes(e.mode) ? e.mode : "rewrite",
      diff: typeof e.diff === "string" ? e.diff : undefined,
      content: typeof e.content === "string" ? e.content : undefined,
      rationale: typeof e.rationale === "string" ? e.rationale : undefined,
    }));
}

export async function code(
  provider: Provider,
  task: string,
  plan: Plan,
  context: string
): Promise<CoderResult> {
  const prompt = render(loadPrompt("coder"), {
    task,
    plan: JSON.stringify(plan, null, 2),
    context,
  });
  const res = await provider.generate(
    [
      { role: "system", content: loadPrompt("system") },
      { role: "user", content: prompt },
    ],
    { json: true, temperature: 0.2 }
  );
  const parsed = extractJson<any>(res.text);
  return { edits: normalizeEdits(parsed), notes: parsed?.notes };
}
