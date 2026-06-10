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
  // ── Windows / PowerShell catastrophic operations ──
  /\bFormat-Volume\b/i,
  /\b(Clear|Initialize|Remove)-Disk\b/i,
  /\b(Stop|Restart)-Computer\b/i,
  // Recursive force-delete of a drive root, the user profile, or the Windows dir
  // (either -Recurse/-Force order). Defense-in-depth for the PowerShell shell.
  /\bRemove-Item\b[^|\n]*-(Recurse|Force)\b[^|\n]*-(Recurse|Force)\b[^|\n]*(\b[A-Za-z]:\\?(?:\s|$|["'])|\$HOME\b|\$env:USERPROFILE\b|\$env:SystemRoot\b|[\\/]Windows\b)/i,
  // Deleting a whole registry hive
  /\breg\s+delete\s+HK(LM|EY_LOCAL_MACHINE|CR|EY_CLASSES_ROOT)\b/i,
  /\bRemove-Item\b[^|\n]*\bHKLM:/i,
  // cmd recursive wipe of a drive root: rd /s /q C:\
  /\b(rd|rmdir)\s+\/s\s+\/q\s+[A-Za-z]:\\?(\s|$)/i,
  /\bdel\s+\/[sq]\s+.*[A-Za-z]:\\?(\s|$)/i,
];

/** Patterns that require confirmation when confirm_destructive is on. */
const DESTRUCTIVE: RegExp[] = [
  /\brm\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)/i,
  /\bdel\b/i,
  /\brmdir\b/i,
  /\bRemove-Item\b/i,
  /\bRemove-Item\b.*\bHK(CU|LM|CR):/i,
  /\bmv\b/i,
  /\bMove-Item\b/i,
  /\bnpm\s+uninstall\b/i,
  /\bdrop\s+(table|database)\b/i,
  // ── Windows / PowerShell state-changing operations (confirm first) ──
  /\breg\s+(delete|add)\b/i,
  /\b(takeown|icacls)\b/i,
  /\bClear-Content\b/i,
  /\bSet-ItemProperty\b/i,
  /\bStop-Process\b/i,
  /\bUninstall-\w+/i,
  /\bnet\s+user\b.*\/(delete|add)/i,
];

/** Compile config-supplied patterns; fall back to a literal-substring match. */
function compilePatterns(patterns?: string[]): RegExp[] {
  if (!patterns?.length) return [];
  return patterns.map((p) => {
    try {
      return new RegExp(p, "i");
    } catch {
      return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
  });
}

export interface ClassifyOptions {
  /** Config tools.allow_commands — matching commands skip the destructive gate. */
  allow?: string[];
  /** Config tools.deny_commands — matching commands are hard-blocked. */
  deny?: string[];
}

/**
 * Classify a command for the safety gate. Precedence:
 *   deny-list  →  built-in hard-block  →  allow-list  →  built-in destructive.
 * The allow-list can downgrade a *destructive* command to safe (auto-approve),
 * but it can NEVER override a hard-block — you cannot allowlist `rm -rf /`.
 */
export function classifyCommand(
  cmd: string,
  opts?: ClassifyOptions
): "blocked" | "destructive" | "safe" {
  if (compilePatterns(opts?.deny).some((re) => re.test(cmd))) return "blocked";
  if (HARD_BLOCK.some((re) => re.test(cmd))) return "blocked";
  if (compilePatterns(opts?.allow).some((re) => re.test(cmd))) return "safe";
  if (DESTRUCTIVE.some((re) => re.test(cmd))) return "destructive";
  return "safe";
}

async function execute(cmd: string, ctx: ToolContext): Promise<ToolResult> {
  const common = { cwd: ctx.cwd, timeout: 120_000, reject: false, all: true } as const;
  // On Windows, run through PowerShell (not cmd.exe) so real cmdlets like
  // Get-WinEvent / Get-Process / Get-Service work. We pass the command as a
  // single -Command argument (execa escapes it) rather than -EncodedCommand:
  // base64-encoded commands are flagged/stalled by some antivirus products.
  // `-InputFormat None` + ignoring stdin stops PowerShell hanging when launched
  // without a console.
  const result =
    process.platform === "win32"
      ? await execa(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-InputFormat", "None", "-ExecutionPolicy", "Bypass", "-Command", cmd],
          { ...common, stdin: "ignore", windowsVerbatimArguments: false }
        )
      : await execa(cmd, { ...common, shell: true });
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

    const cls = classifyCommand(cmd, { allow: ctx.allowCommands, deny: ctx.denyCommands });
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
