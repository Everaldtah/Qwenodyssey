/**
 * Git tools backed by simple-git.
 */
import { simpleGit, SimpleGit } from "simple-git";
import type { Tool, ToolContext, ToolResult } from "../types";

function git(ctx: ToolContext): SimpleGit {
  return simpleGit({ baseDir: ctx.cwd });
}

export async function isRepo(cwd: string): Promise<boolean> {
  try {
    return await simpleGit({ baseDir: cwd }).checkIsRepo();
  } catch {
    return false;
  }
}

export async function isDirty(cwd: string): Promise<boolean> {
  try {
    const status = await simpleGit({ baseDir: cwd }).status();
    return !status.isClean();
  } catch {
    return false;
  }
}

export const gitStatusTool: Tool = {
  name: "git_status",
  description: "Show git working-tree status.",
  mutating: false,
  async run(_args, ctx): Promise<ToolResult> {
    if (!(await isRepo(ctx.cwd))) return { ok: false, output: "Not a git repository." };
    const status = await git(ctx).status();
    const lines = [
      `branch: ${status.current}`,
      `clean: ${status.isClean()}`,
      ...status.files.map((f) => `  ${f.index}${f.working_dir} ${f.path}`),
    ];
    return { ok: true, output: lines.join("\n"), data: status };
  },
};

export const gitDiffTool: Tool = {
  name: "git_diff",
  description: "Show the current git diff (optionally for one path).",
  mutating: false,
  async run(args, ctx): Promise<ToolResult> {
    if (!(await isRepo(ctx.cwd))) return { ok: false, output: "Not a git repository." };
    const diff = args.path
      ? await git(ctx).diff(["--", String(args.path)])
      : await git(ctx).diff();
    return { ok: true, output: diff || "(no changes)", data: diff };
  },
};
