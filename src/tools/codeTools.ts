/**
 * Code-navigation tools — the grounding layer that lets small models behave
 * like they have an IDE. Backed by core/symbolIndex.ts. The index is built
 * lazily on first use and cached on the tool context.
 *
 * Tools:
 *   find_symbol      — locate a definition by name (file:line + signature)
 *   search_symbols   — fuzzy symbol search by substring
 *   outline_file     — list every definition in a file, in order
 *   find_references  — every whole-word use of a name across the repo
 *   read_symbol      — read just one function/class body, not the whole file
 *   apply_edit       — apply a SEARCH/REPLACE block (reliable small-model edits)
 */
import * as path from "path";
import type { Tool, ToolContext, ToolResult } from "../types";
import { SymbolIndex, type SymbolDef } from "../core/symbolIndex";
import { applyEditBlocks, explainFailure, type EditBlock } from "../core/editBlock";
import { resolveWritable } from "./fileTools";
import * as fs from "fs";

/** Per-context cached index (keyed by root) so we build once per session. */
const indexCache = new Map<string, SymbolIndex>();

async function getIndex(ctx: ToolContext): Promise<SymbolIndex> {
  const key = path.resolve(ctx.cwd);
  let idx = indexCache.get(key);
  if (!idx) {
    idx = new SymbolIndex(ctx.cwd);
    await idx.build();
    indexCache.set(key, idx);
  }
  return idx;
}

/** Force a rebuild (e.g. after a batch of edits changed declarations). */
export async function invalidateIndex(ctx: ToolContext): Promise<void> {
  const key = path.resolve(ctx.cwd);
  const idx = indexCache.get(key);
  if (idx) await idx.build();
}

/** Build + cache the index ahead of first use (called at session startup). */
export async function prewarmSymbolIndex(ctx: ToolContext): Promise<void> {
  await getIndex(ctx);
}

function fmtDef(d: SymbolDef): string {
  return `${d.file}:${d.line}  [${d.kind}]  ${d.signature}`;
}

export const findSymbolTool: Tool = {
  name: "find_symbol",
  description:
    "Find where a function, class, interface, type, or constant is DEFINED. " +
    "Returns file:line and the declaration. Use this before editing so you edit the right place.",
  mutating: false,
  async run(args, ctx): Promise<ToolResult> {
    const name = String(args.name || "").trim();
    if (!name) return { ok: false, output: "Provide a symbol 'name'." };
    const idx = await getIndex(ctx);
    const hits = idx.find(name, args.kind ? String(args.kind) as any : undefined);
    if (!hits.length) {
      // Offer fuzzy suggestions so the model can correct a typo.
      const near = idx.search(name, 6).map((d) => d.name);
      const hint = near.length ? ` Did you mean: ${[...new Set(near)].join(", ")}?` : "";
      return { ok: false, output: `No definition named "${name}".${hint}` };
    }
    ctx.log({ tool: "find_symbol", name, hits: hits.length });
    return { ok: true, output: hits.map(fmtDef).join("\n"), data: hits };
  },
};

export const searchSymbolsTool: Tool = {
  name: "search_symbols",
  description:
    "Fuzzy-search symbol names across the project (substring match). Use when you " +
    "don't know the exact name. Returns ranked file:line declarations.",
  mutating: false,
  async run(args, ctx): Promise<ToolResult> {
    const q = String(args.query || "").trim();
    if (!q) return { ok: false, output: "Provide a 'query'." };
    const idx = await getIndex(ctx);
    const hits = idx.search(q, Number(args.limit) || 25);
    if (!hits.length) return { ok: true, output: `No symbols matching "${q}".` };
    ctx.log({ tool: "search_symbols", query: q, hits: hits.length });
    return { ok: true, output: hits.map(fmtDef).join("\n"), data: hits };
  },
};

export const outlineFileTool: Tool = {
  name: "outline_file",
  description:
    "List every definition (functions, classes, methods, types) in a file, in order, " +
    "with line numbers. A cheap structural map — read this before reading a whole large file.",
  mutating: false,
  async run(args, ctx): Promise<ToolResult> {
    const rel = String(args.path || "").trim();
    if (!rel) return { ok: false, output: "Provide a file 'path'." };
    const idx = await getIndex(ctx);
    const defs = idx.outline(rel);
    if (!defs.length) return { ok: true, output: `No indexed symbols in ${rel} (or file not found).` };
    ctx.log({ tool: "outline_file", path: rel, defs: defs.length });
    return {
      ok: true,
      output: defs.map((d) => `L${d.line}\t[${d.kind}]\t${d.name}`).join("\n"),
      data: defs,
    };
  },
};

export const findReferencesTool: Tool = {
  name: "find_references",
  description:
    "Find every place a name is USED across the codebase (whole-word). Definitions are " +
    "marked. Use before renaming or changing a signature to see the blast radius.",
  mutating: false,
  async run(args, ctx): Promise<ToolResult> {
    const name = String(args.name || "").trim();
    if (!name) return { ok: false, output: "Provide a 'name'." };
    const idx = await getIndex(ctx);
    const refs = idx.references(name, Number(args.limit) || 80);
    if (!refs.length) return { ok: true, output: `No references to "${name}".` };
    ctx.log({ tool: "find_references", name, refs: refs.length });
    const body = refs.map((r) => `${r.file}:${r.line}${r.isDefinition ? " (def)" : ""}\t${r.text}`).join("\n");
    return { ok: true, output: body, data: refs };
  },
};

export const readSymbolTool: Tool = {
  name: "read_symbol",
  description:
    "Read the body of ONE symbol (function/class/method) by name, instead of the whole file. " +
    "Keeps context small. If the name is ambiguous, the first definition is returned.",
  mutating: false,
  async run(args, ctx): Promise<ToolResult> {
    const name = String(args.name || "").trim();
    if (!name) return { ok: false, output: "Provide a symbol 'name'." };
    const idx = await getIndex(ctx);
    const hits = idx.find(name);
    if (!hits.length) return { ok: false, output: `No definition named "${name}".` };
    const def = args.file ? hits.find((h) => h.file === String(args.file)) ?? hits[0] : hits[0];
    const body = idx.readSymbol(def, Number(args.max_lines) || 200);
    if (body == null) return { ok: false, output: `Could not read ${def.file}.` };
    ctx.log({ tool: "read_symbol", name, file: def.file });
    return {
      ok: true,
      output: `// ${def.file}:${def.line}\n${body}`,
      data: { def, body },
    };
  },
};

export const applyEditTool: Tool = {
  name: "apply_edit",
  description:
    "Apply a precise code edit using a SEARCH/REPLACE block — the RELIABLE way to edit files " +
    "(preferred over write_file for changes to existing files). Provide 'path', the exact " +
    "'search' text to find (copy it verbatim from the file), and the 'replace' text. " +
    "Leave 'search' empty to create a new file or append. Whitespace-tolerant with auto-repair.",
  mutating: true,
  async run(args, ctx): Promise<ToolResult> {
    const rel = String(args.path || "").trim();
    if (!rel) return { ok: false, output: "Provide a file 'path'." };
    const block: EditBlock = {
      path: rel,
      search: String(args.search ?? ""),
      replace: String(args.replace ?? ""),
    };
    const results = applyEditBlocks([block], (p) => resolveWritable(ctx, p));
    const r = results[0];
    if (!r) return { ok: false, output: "No edit applied." };
    if (!r.ok) {
      // Give the model targeted feedback to fix its SEARCH on the next try.
      let detail = r.error ?? "edit failed";
      try {
        const abs = resolveWritable(ctx, rel);
        if (fs.existsSync(abs)) detail = explainFailure(fs.readFileSync(abs, "utf-8"), block);
      } catch {
        /* ignore */
      }
      ctx.log({ tool: "apply_edit", path: rel, ok: false });
      return { ok: false, output: detail };
    }
    // Declarations may have changed — rebuild the index in the background.
    void invalidateIndex(ctx);
    const note =
      r.strategy && r.strategy !== "exact"
        ? ` (matched via ${r.strategy}${r.confidence != null && r.confidence < 1 ? `, confidence ${(r.confidence * 100).toFixed(0)}%` : ""})`
        : "";
    ctx.log({ tool: "apply_edit", path: rel, ok: true, strategy: r.strategy });
    return { ok: true, output: `Edited ${rel}${note}.` };
  },
};

export const CODE_NAV_TOOLS: Tool[] = [
  findSymbolTool,
  searchSymbolsTool,
  outlineFileTool,
  findReferencesTool,
  readSymbolTool,
  applyEditTool,
];
