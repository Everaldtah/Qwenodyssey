/**
 * Pack the most useful context into a small token budget. Designed for 7B
 * models: relevant files first, then errors, then structure, then memory.
 */
import * as fs from "fs";
import * as path from "path";
import type { Provider, RepoInfo } from "../types";
import { summarizeRepo } from "./repoScanner";
import { resolveInside } from "../tools/fileTools";

export interface ContextInput {
  userRequest: string;
  repo: RepoInfo;
  files: string[]; // candidate relevant files (relative paths)
  errors?: string;
  gitDiff?: string;
  memory?: string;
  budgetTokens: number;
}

interface Section {
  label: string;
  body: string;
  priority: number; // lower = more important
}

const approxTokens = (s: string) => Math.ceil(s.length / 4);

export function buildContext(provider: Provider, input: ContextInput): string {
  const sections: Section[] = [];

  // 1. User request (always first / never dropped)
  sections.push({ label: "USER REQUEST", body: input.userRequest, priority: 1 });

  // 2. Relevant files
  for (const rel of input.files) {
    try {
      const abs = resolveInside(input.repo.root, rel);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue;
      const raw = fs.readFileSync(abs, "utf-8");
      const clipped = clip(raw, 8000);
      sections.push({
        label: `FILE: ${rel}`,
        body: "```\n" + clipped + "\n```",
        priority: 2,
      });
    } catch {
      /* skip unreadable */
    }
  }

  // 3. Current errors
  if (input.errors) {
    sections.push({ label: "FAILING OUTPUT", body: clip(input.errors, 4000), priority: 3 });
  }

  // 4. Repo structure
  sections.push({ label: "REPO", body: summarizeRepo(input.repo), priority: 4 });

  // 5. Git diff
  if (input.gitDiff) {
    sections.push({ label: "CURRENT GIT DIFF", body: clip(input.gitDiff, 3000), priority: 5 });
  }

  // 6. Memory
  if (input.memory) {
    sections.push({ label: "PROJECT MEMORY", body: clip(input.memory, 2000), priority: 6 });
  }

  // Greedily include by priority until budget is exhausted.
  sections.sort((a, b) => a.priority - b.priority);
  const out: string[] = [];
  let used = 0;
  for (const s of sections) {
    const block = `## ${s.label}\n${s.body}\n`;
    const cost = approxTokens(block);
    if (used + cost > input.budgetTokens && s.priority > 1) continue;
    out.push(block);
    used += cost;
  }
  return out.join("\n");
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.7));
  const tail = text.slice(-Math.floor(maxChars * 0.2));
  return `${head}\n… [${text.length - maxChars} chars omitted] …\n${tail}`;
}

/** Heuristic relevant-file picker when the planner doesn't name files. */
export function guessRelevantFiles(repo: RepoInfo, request: string, limit = 6): string[] {
  const terms = request
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 3);
  const scored = repo.keyFiles
    .concat(repo.entrypoints)
    .map((f) => {
      const name = path.basename(f).toLowerCase();
      const score = terms.reduce((acc, t) => acc + (name.includes(t) ? 1 : 0), 0);
      return { f, score };
    })
    .sort((a, b) => b.score - a.score);
  const uniq = [...new Set(scored.map((s) => s.f))];
  return uniq.slice(0, limit);
}
