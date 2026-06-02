/**
 * Filesystem tools. All paths are resolved relative to ctx.cwd and are
 * prevented from escaping the project root.
 */
import * as fs from "fs";
import * as path from "path";
import fg from "fast-glob";
import type { Tool, ToolContext, ToolResult } from "../types";

export function resolveInside(cwd: string, p: string): string {
  const abs = path.resolve(cwd, p);
  const root = path.resolve(cwd);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes project root: ${p}`);
  }
  return abs;
}

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file.",
  mutating: false,
  async run(args, ctx): Promise<ToolResult> {
    const abs = resolveInside(ctx.cwd, String(args.path));
    if (!fs.existsSync(abs)) return { ok: false, output: `Not found: ${args.path}` };
    const content = fs.readFileSync(abs, "utf-8");
    ctx.log({ tool: "read_file", path: args.path, bytes: content.length });
    return { ok: true, output: content, data: content };
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Overwrite (or create) a file with the given content.",
  mutating: true,
  async run(args, ctx): Promise<ToolResult> {
    const abs = resolveInside(ctx.cwd, String(args.path));
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
    const abs = resolveInside(ctx.cwd, String(args.path));
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
    const abs = resolveInside(ctx.cwd, String(args.path));
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
    const pattern = String(args.pattern || "**/*");
    const files = await fg(pattern, {
      cwd: ctx.cwd,
      dot: false,
      ignore: IGNORE,
      onlyFiles: true,
      followSymbolicLinks: false,
    });
    return { ok: true, output: files.join("\n"), data: files };
  },
};

export const treeTool: Tool = {
  name: "tree",
  description: "Show a compact directory tree (depth-limited).",
  mutating: false,
  async run(args, ctx): Promise<ToolResult> {
    const maxDepth = Number(args.depth ?? 2);
    const files = await fg("**/*", {
      cwd: ctx.cwd,
      ignore: IGNORE,
      onlyFiles: false,
      markDirectories: true,
      deep: maxDepth,
      followSymbolicLinks: false,
    });
    const tree = files.sort().join("\n");
    return { ok: true, output: tree, data: files };
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
