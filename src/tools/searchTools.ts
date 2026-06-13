/**
 * Search tools: grep across the repo and a simple docs lookup.
 */
import * as fs from "fs";
import * as path from "path";
import fg from "fast-glob";
import type { Tool, ToolContext, ToolResult } from "../types";
import { IGNORE, resolveReadableSmart } from "./fileTools";

export const grepTool: Tool = {
  name: "grep",
  description: "Search file contents for a regex pattern.",
  mutating: false,
  async run(args, ctx): Promise<ToolResult> {
    const pattern = String(args.pattern || "");
    if (!pattern) return { ok: false, output: "No pattern given" };
    const base = resolveReadableSmart(ctx.cwd, args.path ? String(args.path) : ".");
    if (!fs.existsSync(base)) return { ok: false, output: `Directory not found: ${base}` };
    const glob = String(args.glob || "**/*");
    let re: RegExp;
    try {
      re = new RegExp(pattern, args.ignoreCase ? "i" : undefined);
    } catch (e) {
      return { ok: false, output: `Invalid regex: ${(e as Error).message}` };
    }
    const files = await fg(glob, {
      cwd: base,
      ignore: IGNORE,
      onlyFiles: true,
      followSymbolicLinks: false,
    });
    const hits: string[] = [];
    const maxHits = Number(args.limit ?? 200);
    for (const rel of files) {
      let content: string;
      try {
        content = fs.readFileSync(path.join(base, rel), "utf-8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= maxHits) break;
        }
      }
      if (hits.length >= maxHits) break;
    }
    return { ok: true, output: hits.join("\n") || "(no matches)", data: hits };
  },
};

export const searchDocsTool: Tool = {
  name: "search_docs",
  description: "Search README and docs/ for a keyword.",
  mutating: false,
  async run(args, ctx): Promise<ToolResult> {
    const q = String(args.query || "").toLowerCase();
    const files = await fg(["README*", "docs/**/*.md", "**/*.md"], {
      cwd: ctx.cwd,
      ignore: IGNORE,
      onlyFiles: true,
    });
    const hits: string[] = [];
    for (const rel of files.slice(0, 100)) {
      const content = fs.readFileSync(path.join(ctx.cwd, rel), "utf-8");
      if (content.toLowerCase().includes(q)) {
        const idx = content.toLowerCase().indexOf(q);
        hits.push(`${rel}: …${content.slice(Math.max(0, idx - 60), idx + 120).replace(/\n/g, " ")}…`);
      }
    }
    return { ok: true, output: hits.join("\n") || "(no matches)", data: hits };
  },
};
