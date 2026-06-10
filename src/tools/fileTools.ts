/**
 * Filesystem tools. All paths are resolved relative to ctx.cwd and are
 * prevented from escaping the project root.
 */
import * as fs from "fs";
import * as path from "path";
import fg from "fast-glob";
import type { Tool, ToolContext, ToolResult } from "../types";

/** Resolve a path for WRITES/DELETES: must stay inside the project root. */
export function resolveInside(cwd: string, p: string): string {
  const abs = path.resolve(cwd, p);
  const root = path.resolve(cwd);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes project root: ${p}`);
  }
  return abs;
}

/**
 * Resolve a path for READ-ONLY access. Relative paths resolve against the
 * project dir; an absolute path (e.g. "C:\\Projects\\Overstory") is allowed
 * anywhere on the machine, so the assistant can inspect a directory the user
 * names even when it's outside the launch dir. Use resolveInside() for writes.
 */
export function resolveReadable(cwd: string, p?: string): string {
  return path.resolve(cwd, p && String(p).trim() ? String(p) : ".");
}

/**
 * Resolve a path for WRITES, allowing either the project root OR the agent's own
 * source root (ctx.selfRoot) — so Qwenodyssey can modify itself. Anything else
 * is rejected to avoid scribbling across the whole machine.
 */
export function resolveWritable(ctx: ToolContext, p: string): string {
  const abs = path.resolve(ctx.cwd, p);
  const roots = [path.resolve(ctx.cwd)];
  if (ctx.selfRoot) roots.push(path.resolve(ctx.selfRoot));
  for (const root of roots) {
    if (abs === root || abs.startsWith(root + path.sep)) return abs;
  }
  throw new Error(`Path escapes the allowed roots (project or agent source): ${p}`);
}

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file, optionally a line range (offset/limit) for large files.",
  mutating: false,
  async run(args, ctx): Promise<ToolResult> {
    const abs = resolveReadable(ctx.cwd, String(args.path));
    if (!fs.existsSync(abs)) return { ok: false, output: `Not found: ${args.path}` };
    if (fs.statSync(abs).isDirectory())
      return { ok: false, output: `${args.path} is a directory — use tree or list_files for it.` };
    const content = fs.readFileSync(abs, "utf-8");
    ctx.log({ tool: "read_file", path: args.path, bytes: content.length });

    // Pagination: when offset/limit are given (or the file is very large) return
    // a window of lines plus a header telling the model how to fetch the next
    // page, instead of dumping a huge file into the context.
    const hasWindow = args.offset !== undefined || args.limit !== undefined;
    const lines = content.split("\n");
    const total = lines.length;
    const AUTO_PAGE = 800; // auto-paginate files longer than this even without args
    if (hasWindow || total > AUTO_PAGE) {
      const start = Math.max(1, Number(args.offset) || 1); // 1-based line number
      const count = Math.max(1, Number(args.limit) || AUTO_PAGE);
      const end = Math.min(total, start + count - 1);
      const slice = lines.slice(start - 1, end).join("\n");
      const more =
        end < total
          ? `\n…(${total - end} more lines — call read_file again with offset=${end + 1})`
          : "";
      const header = `${args.path} — lines ${start}-${end} of ${total}\n`;
      return { ok: true, output: header + slice + more, data: content };
    }
    return { ok: true, output: content, data: content };
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Overwrite (or create) a file with the given content.",
  mutating: true,
  async run(args, ctx): Promise<ToolResult> {
    const abs = resolveWritable(ctx, String(args.path));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(args.content ?? ""), "utf-8");
    ctx.log({ tool: "write_file", path: args.path });
    return { ok: true, output: `Wrote ${args.path}` };
  },
};

export const createFileTool: Tool = {
  name: "create_file",
  description: "Create a new file. Fails if it already exists.",
  mutating: true,
  async run(args, ctx): Promise<ToolResult> {
    const abs = resolveWritable(ctx, String(args.path));
    if (fs.existsSync(abs)) return { ok: false, output: `Already exists: ${args.path}` };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(args.content ?? ""), "utf-8");
    ctx.log({ tool: "create_file", path: args.path });
    return { ok: true, output: `Created ${args.path}` };
  },
};

export const deleteFileTool: Tool = {
  name: "delete_file",
  description: "Delete a file.",
  mutating: true,
  async run(args, ctx): Promise<ToolResult> {
    const abs = resolveWritable(ctx, String(args.path));
    if (!fs.existsSync(abs)) return { ok: false, output: `Not found: ${args.path}` };
    fs.rmSync(abs);
    ctx.log({ tool: "delete_file", path: args.path });
    return { ok: true, output: `Deleted ${args.path}` };
  },
};

export const listFilesTool: Tool = {
  name: "list_files",
  description: "List files matching an optional glob (default: all tracked-ish files).",
  mutating: false,
  async run(args, ctx): Promise<ToolResult> {
    const base = resolveReadable(ctx.cwd, args.path ? String(args.path) : ".");
    if (!fs.existsSync(base)) return { ok: false, output: `Directory not found: ${base}` };
    const pattern = String(args.pattern || "**/*");
    const files = await fg(pattern, {
      cwd: base,
      dot: false,
      ignore: IGNORE,
      onlyFiles: true,
      followSymbolicLinks: false,
    });
    const cap = 500;
    const shown = files.slice(0, cap);
    const note =
      files.length > cap ? `\n…(${files.length - cap} more; narrow with a pattern or subdir path)` : "";
    const header = `${base} — ${files.length} file(s)\n`;
    return { ok: true, output: header + shown.join("\n") + note, data: files };
  },
};

export const treeTool: Tool = {
  name: "tree",
  description: "Show a compact directory tree (depth-limited).",
  mutating: false,
  async run(args, ctx): Promise<ToolResult> {
    const base = resolveReadable(ctx.cwd, args.path ? String(args.path) : ".");
    if (!fs.existsSync(base)) return { ok: false, output: `Directory not found: ${base}` };
    if (!fs.statSync(base).isDirectory())
      return { ok: false, output: `${base} is a file, not a directory — use read_file.` };
    const maxDepth = Number(args.depth ?? 2);
    const files = await fg("**/*", {
      cwd: base,
      ignore: IGNORE,
      onlyFiles: false,
      markDirectories: true,
      deep: maxDepth,
      followSymbolicLinks: false,
    });
    const sorted = files.sort();
    const cap = 400;
    const shown = sorted.slice(0, cap);
    const note =
      sorted.length > cap
        ? `\n…(${sorted.length - cap} more entries; tree a subdirectory or raise depth to see more)`
        : "";
    const header = `${base}  (depth ${maxDepth}, ${sorted.length} entries)\n`;
    return { ok: true, output: header + shown.join("\n") + note, data: files };
  },
};

export const IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.qwenodyssey/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/target/**",
  "**/*.lock",
];
