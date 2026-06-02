/**
 * Load prompt templates shipped under src/prompts. Resolves both in-repo
 * (dev) and installed-package layouts.
 */
import * as fs from "fs";
import * as path from "path";

const CANDIDATES = [
  path.resolve(__dirname, "..", "prompts"), // dist/prompts (if copied)
  path.resolve(__dirname, "..", "..", "src", "prompts"), // installed/dev: <root>/src/prompts
];

const cache = new Map<string, string>();

export function loadPrompt(name: string): string {
  if (cache.has(name)) return cache.get(name)!;
  const file = `${name}.md`;
  for (const dir of CANDIDATES) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, "utf-8");
      cache.set(name, text);
      return text;
    }
  }
  throw new Error(`Prompt template not found: ${file}`);
}

/** Fill {{placeholders}} in a template. */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? "");
}
