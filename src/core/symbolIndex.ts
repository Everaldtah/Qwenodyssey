/**
 * Lightweight, dependency-free symbol index.
 *
 * Frontier models get "go to definition" / "find references" for free from the
 * IDE context they were trained on; small local models don't. Giving them cheap
 * grounding tools — "where is function X defined?", "what calls it?", "outline
 * this file" — dramatically cuts the rate at which they edit the wrong place or
 * hallucinate APIs.
 *
 * This is a regex-based extractor (not a full parser) covering the common
 * declaration shapes across TS/JS, Python, Go, Rust, Java/Kotlin, C/C++, Ruby,
 * and PHP. It is intentionally approximate: fast, no native deps, good enough to
 * point a model at the right file:line. Definitions are indexed precisely;
 * "references" are a whole-word text search (with a definition flag), which is
 * the right precision/recall tradeoff for a 7B's needs.
 */
import * as fs from "fs";
import * as path from "path";
import fg from "fast-glob";

export type SymbolKind = "function" | "class" | "method" | "interface" | "type" | "const" | "enum" | "struct" | "trait";

export interface SymbolDef {
  name: string;
  kind: SymbolKind;
  file: string; // relative path
  line: number; // 1-based
  signature: string; // the trimmed declaration line
}

export interface Reference {
  file: string;
  line: number;
  text: string;
  isDefinition: boolean;
}

interface LangRule {
  test: RegExp; // file extension match
  patterns: { re: RegExp; kind: SymbolKind; nameGroup: number }[];
}

const RULES: LangRule[] = [
  {
    test: /\.(ts|tsx|js|jsx|mjs|cjs)$/,
    patterns: [
      { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function", nameGroup: 1 },
      { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", nameGroup: 1 },
      { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface", nameGroup: 1 },
      { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: "type", nameGroup: 1 },
      { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum", nameGroup: 1 },
      { re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, kind: "function", nameGroup: 1 },
      { re: /^\s*(?:export\s+)?const\s+([A-Z][\w$]*)\s*[:=]/, kind: "const", nameGroup: 1 },
      { re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/, kind: "method", nameGroup: 1 },
    ],
  },
  {
    test: /\.py$/,
    patterns: [
      { re: /^\s*def\s+([A-Za-z_]\w*)/, kind: "function", nameGroup: 1 },
      { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class", nameGroup: 1 },
    ],
  },
  {
    test: /\.go$/,
    patterns: [
      { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function", nameGroup: 1 },
      { re: /^\s*type\s+([A-Za-z_]\w*)\s+struct/, kind: "struct", nameGroup: 1 },
      { re: /^\s*type\s+([A-Za-z_]\w*)\s+interface/, kind: "interface", nameGroup: 1 },
    ],
  },
  {
    test: /\.rs$/,
    patterns: [
      { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function", nameGroup: 1 },
      { re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct", nameGroup: 1 },
      { re: /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/, kind: "trait", nameGroup: 1 },
      { re: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum", nameGroup: 1 },
    ],
  },
  {
    test: /\.(java|kt)$/,
    patterns: [
      { re: /^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, kind: "class", nameGroup: 1 },
      { re: /^\s*(?:public\s+|private\s+|protected\s+)?interface\s+([A-Za-z_]\w*)/, kind: "interface", nameGroup: 1 },
      { re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+)*[\w<>\[\].]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/, kind: "method", nameGroup: 1 },
      { re: /^\s*fun\s+([A-Za-z_]\w*)/, kind: "function", nameGroup: 1 },
    ],
  },
  {
    test: /\.(c|h|cpp|cc|hpp|cxx)$/,
    patterns: [
      { re: /^\s*(?:[\w*&<>:]+\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, kind: "function", nameGroup: 1 },
      { re: /^\s*(?:class|struct)\s+([A-Za-z_]\w*)/, kind: "class", nameGroup: 1 },
    ],
  },
  {
    test: /\.rb$/,
    patterns: [
      { re: /^\s*def\s+([A-Za-z_]\w*[!?]?)/, kind: "function", nameGroup: 1 },
      { re: /^\s*(?:class|module)\s+([A-Za-z_]\w*)/, kind: "class", nameGroup: 1 },
    ],
  },
  {
    test: /\.php$/,
    patterns: [
      { re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_]\w*)/, kind: "function", nameGroup: 1 },
      { re: /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, kind: "class", nameGroup: 1 },
      { re: /^\s*interface\s+([A-Za-z_]\w*)/, kind: "interface", nameGroup: 1 },
    ],
  },
];

const IGNORE_DIRS = ["node_modules", ".git", "dist", "build", ".next", "out", "target", "__pycache__", ".venv", "venv", "vendor"];

export class SymbolIndex {
  private defs: SymbolDef[] = [];
  private byName = new Map<string, SymbolDef[]>();
  private fileList: string[] = [];
  private built = false;

  constructor(private root: string) {}

  /** Build (or rebuild) the index by scanning the project tree. */
  async build(maxFiles = 4000): Promise<void> {
    this.defs = [];
    this.byName.clear();
    const entries = await fg("**/*", {
      cwd: this.root,
      onlyFiles: true,
      dot: false,
      ignore: IGNORE_DIRS.map((d) => `**/${d}/**`),
      followSymbolicLinks: false,
      suppressErrors: true,
    });
    this.fileList = entries.slice(0, maxFiles);
    for (const rel of this.fileList) {
      const rule = RULES.find((r) => r.test.test(rel));
      if (!rule) continue;
      let content: string;
      try {
        const abs = path.join(this.root, rel);
        if (fs.statSync(abs).size > 1_500_000) continue; // skip huge/minified
        content = fs.readFileSync(abs, "utf-8");
      } catch {
        continue;
      }
      this.indexFile(rel, content, rule);
    }
    this.built = true;
  }

  private indexFile(rel: string, content: string, rule: LangRule): void {
    const lines = content.split("\n");
    const seen = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 400) continue; // likely minified
      for (const p of rule.patterns) {
        const m = line.match(p.re);
        if (m && m[p.nameGroup]) {
          const name = m[p.nameGroup];
          const key = `${name}@${i}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const def: SymbolDef = { name, kind: p.kind, file: rel, line: i + 1, signature: line.trim().slice(0, 200) };
          this.defs.push(def);
          if (!this.byName.has(name)) this.byName.set(name, []);
          this.byName.get(name)!.push(def);
          break; // one declaration per line
        }
      }
    }
  }

  isBuilt(): boolean {
    return this.built;
  }

  size(): number {
    return this.defs.length;
  }

  /** Exact-name symbol lookup, optionally filtered by kind. */
  find(name: string, kind?: SymbolKind): SymbolDef[] {
    const hits = this.byName.get(name) ?? [];
    return kind ? hits.filter((d) => d.kind === kind) : hits;
  }

  /** Fuzzy symbol search by substring / case-insensitive contains. */
  search(query: string, limit = 25): SymbolDef[] {
    const q = query.toLowerCase();
    const scored = this.defs
      .map((d) => {
        const n = d.name.toLowerCase();
        let score = 0;
        if (n === q) score = 100;
        else if (n.startsWith(q)) score = 60;
        else if (n.includes(q)) score = 30;
        return { d, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.d);
  }

  /** All definitions in a file, in declaration order — a structural outline. */
  outline(relPath: string): SymbolDef[] {
    return this.defs.filter((d) => d.file === relPath).sort((a, b) => a.line - b.line);
  }

  /**
   * Whole-word references to `name` across the codebase. Flags the line as a
   * definition when it coincides with an indexed declaration. Capped for sanity.
   */
  references(name: string, limit = 80): Reference[] {
    const out: Reference[] = [];
    const wordRe = new RegExp(`\\b${escapeRegex(name)}\\b`);
    const defLines = new Set((this.byName.get(name) ?? []).map((d) => `${d.file}:${d.line}`));
    for (const rel of this.fileList) {
      if (!RULES.some((r) => r.test.test(rel))) continue;
      let content: string;
      try {
        content = fs.readFileSync(path.join(this.root, rel), "utf-8");
      } catch {
        continue;
      }
      if (!content.includes(name)) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (wordRe.test(lines[i])) {
          out.push({
            file: rel,
            line: i + 1,
            text: lines[i].trim().slice(0, 200),
            isDefinition: defLines.has(`${rel}:${i + 1}`),
          });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  /**
   * Read the body of a symbol (its declaration plus a brace/indent-balanced
   * span), so a model can inspect just the relevant function rather than the
   * whole file. Best-effort: brace counting for C-family, indent for Python.
   */
  readSymbol(def: SymbolDef, maxLines = 200): string | null {
    let content: string;
    try {
      content = fs.readFileSync(path.join(this.root, def.file), "utf-8");
    } catch {
      return null;
    }
    const lines = content.split("\n");
    const start = def.line - 1;
    if (start < 0 || start >= lines.length) return null;

    const isPy = /\.py$/.test(def.file);
    let end = start;
    if (isPy) {
      const baseIndent = lines[start].match(/^\s*/)?.[0].length ?? 0;
      end = start + 1;
      while (end < lines.length) {
        const l = lines[end];
        if (l.trim() && (l.match(/^\s*/)?.[0].length ?? 0) <= baseIndent) break;
        end++;
        if (end - start > maxLines) break;
      }
    } else {
      let depth = 0;
      let opened = false;
      for (let i = start; i < lines.length && i - start <= maxLines; i++) {
        for (const ch of lines[i]) {
          if (ch === "{") {
            depth++;
            opened = true;
          } else if (ch === "}") depth--;
        }
        end = i + 1;
        if (opened && depth <= 0) break;
        if (!opened && lines[i].includes(";")) break; // one-liner / prototype
      }
    }
    return lines.slice(start, Math.min(end, start + maxLines)).join("\n");
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
