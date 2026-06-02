/**
 * Project memory: simple markdown-backed notes under .qwenodyssey/memory.
 */
import * as fs from "fs";
import * as path from "path";

export type MemoryCategory = "project" | "user" | "decisions" | "commands";

const FILES: Record<MemoryCategory, string> = {
  project: "project.md",
  user: "user.md",
  decisions: "decisions.md",
  commands: "commands.md",
};

export class MemoryStore {
  constructor(private dir: string) {}

  private file(cat: MemoryCategory): string {
    return path.join(this.dir, FILES[cat]);
  }

  add(text: string, cat: MemoryCategory = "project"): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(this.file(cat), `- (${stamp}) ${text.trim()}\n`, "utf-8");
  }

  list(): { category: MemoryCategory; content: string }[] {
    const out: { category: MemoryCategory; content: string }[] = [];
    for (const cat of Object.keys(FILES) as MemoryCategory[]) {
      const f = this.file(cat);
      if (fs.existsSync(f)) {
        const content = fs.readFileSync(f, "utf-8").trim();
        if (content) out.push({ category: cat, content });
      }
    }
    return out;
  }

  search(query: string): string[] {
    const q = query.toLowerCase();
    const hits: string[] = [];
    for (const { category, content } of this.list()) {
      for (const line of content.split("\n")) {
        if (line.toLowerCase().includes(q)) hits.push(`[${category}] ${line.replace(/^- /, "")}`);
      }
    }
    return hits;
  }

  /** Concatenated memory for prompt context (bounded by the caller). */
  digest(): string {
    return this.list()
      .map(({ category, content }) => `### ${category}\n${content}`)
      .join("\n\n");
  }

  clear(): void {
    for (const cat of Object.keys(FILES) as MemoryCategory[]) {
      const f = this.file(cat);
      if (fs.existsSync(f)) fs.rmSync(f);
    }
  }
}
