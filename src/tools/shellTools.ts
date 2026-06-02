/**
 * Shell execution with a hard blocklist for catastrophic commands and an
 * optional confirmation gate for anything that looks destructive.
 */
import execa from "execa";
import prompts from "prompts";
import type { Tool, ToolContext, ToolResult } from "../types";

/** Patterns that are NEVER run, regardless of confirmation. */
const HARD_BLOCK: RegExp[] = [
  /\brm\s+-rf?\s+(\/|~|\$HOME|\.\.)(\s|$)/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, // classic fork bomb :(){ :|:& };:
  /\bformat\s+[a-z]:/i, // Windows format C:
  />\s*\/dev\/sda/i,
  /\bchmod\s+-R\s+777\s+\//i,
];

/** Patterns that require confirmation when confirm_destructive is on. */
const DESTRUCTIVE: RegExp[] = [
  /\brm\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)/i,
  /\bdel\b/i,
  /\brmdir\b/i,
  /\bRemove-Item\b/i,
  /\bmv\b/i,
  /\bnpm\s+uninstall\b/i,
  /\bdrop\s+(table|database)\b/i,
];

export function classifyCommand(cmd: string): "blocked" | "destructive" | "safe" {
  if (HARD_BLOCK.some((re) => re.test(cmd))) return "blocked";
  if (DESTRUCTIVE.some((re) => re.test(cmd))) return "destructive";
  return "safe";
}

async function execute(cmd: string, ctx: ToolContext): Promise<ToolResult> {
  const result = await execa(cmd, {
    cwd: ctx.cwd,
    shell: true,
    timeout: 120_000,
    reject: false,
    all: true,
  });
  const out = (result.all ?? result.stdout ?? "").toString();
  ctx.log({
    tool: "run_shell",
    command: cmd,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  });
  return {
    ok: result.exitCode === 0,
    output: out + (result.timedOut ? "\n[timed out after 120s]" : ""),
    data: { exitCode: result.exitCode },
  };
}

export const runShellTool: Tool = {
  name: "run_shell",
  description: "Run a shell command in the project directory.",
  mutating: true,
  async run(args, ctx): Promise<ToolResult> {
    const cmd = String(args.command || "").trim();
    if (!cmd) return { ok: false, output: "No command given" };
    if (!ctx.allowShell) {
      return { ok: false, output: "Shell execution is disabled (tools.allow_shell=false)" };
    }

    const cls = classifyCommand(cmd);
    if (cls === "blocked") {
      ctx.log({ tool: "run_shell", command: cmd, blocked: true });
      return { ok: false, output: `Refused: "${cmd}" matches a hard-blocked dangerous pattern.` };
    }
    if (cls === "destructive" && ctx.confirmDestructive && !ctx.autoConfirm) {
      const { go } = await prompts({
        type: "confirm",
        name: "go",
        message: `Run potentially destructive command?\n  ${cmd}`,
        initial: false,
      });
      if (!go) {
        ctx.log({ tool: "run_shell", command: cmd, declined: true });
        return { ok: false, output: "Declined by user." };
      }
    }
    return execute(cmd, ctx);
  },
};
