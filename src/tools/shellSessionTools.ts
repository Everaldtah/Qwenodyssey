/**
 * Tools exposing a persistent shell session (see core/shellSession). These give
 * a small model a terminal whose STATE PERSISTS across calls — so `cd`, venv
 * activation, exported env vars, REPLs, and long-running servers all survive
 * between tool calls, and a long command can be started then polled instead of
 * blocking the whole turn or being killed at the timeout.
 *
 * Registered only when tools.shell_session is enabled (it weakens the
 * per-command isolation of the default run_shell, so it's opt-in).
 */
import type { Tool, ToolSpec } from "../types";
import { ShellSession, RunResult } from "../core/shellSession";
import { classifyCommand } from "./shellTools";
import { stripRedundantCwdPrefixInCommand } from "./fileTools";

const str = (description: string) => ({ type: "string", description });

function format(r: RunResult): { ok: boolean; output: string } {
  const body = r.output.trim();
  switch (r.status) {
    case "done":
      return {
        ok: r.exitCode === 0 || r.exitCode == null,
        output: (body || "(no output)") + `\n[finished, exit code ${r.exitCode ?? "?"}]`,
      };
    case "running":
      return {
        ok: true,
        output:
          (body || "(no output yet)") +
          "\n[still running — call shell_session_read to get more output once it progresses]",
      };
    case "busy":
    case "idle":
    case "error":
      return { ok: r.status !== "error", output: body };
    default:
      return { ok: true, output: body };
  }
}

export function createShellSessionTools(session: ShellSession): Tool[] {
  const shellSession: Tool = {
    name: "shell_session",
    description:
      "Run a command in a PERSISTENT shell whose state (cwd, env vars, activated venv, running " +
      "processes) survives between calls — unlike run_shell, which is fresh each time. Use it when " +
      "commands depend on each other (cd then build), or to start a long-running process (server, " +
      "watcher, REPL) and poll it with shell_session_read.",
    mutating: true,
    async run(args, ctx) {
      if (!ctx.allowShell) return { ok: false, output: "Shell execution is disabled (tools.allow_shell=false)." };
      const rawCommand = String(args.command || "").trim();
      if (!rawCommand) return { ok: false, output: "No command given" };
      const command = stripRedundantCwdPrefixInCommand(ctx.cwd, rawCommand);
      const cls = classifyCommand(command, { allow: ctx.allowCommands, deny: ctx.denyCommands });
      if (cls === "blocked") {
        ctx.log({ tool: "shell_session", command, blocked: true });
        return { ok: false, output: `Refused: "${command}" matches a hard-blocked/deny-listed pattern.` };
      }
      const timeout = Math.min(Math.max(Number(args.timeout_ms) || 15000, 1000), 120000);
      const r = await session.run(command, timeout);
      ctx.log({ tool: "shell_session", command, status: r.status, exitCode: r.exitCode });
      return format(r);
    },
  };

  const shellSessionRead: Tool = {
    name: "shell_session_read",
    description:
      "Read more output from a command still running in the persistent shell (started by " +
      "shell_session). Returns new output and whether the command has finished.",
    mutating: false,
    async run(args, ctx) {
      const timeout = Math.min(Math.max(Number(args.timeout_ms) || 10000, 500), 120000);
      const r = await session.read(timeout);
      ctx.log({ tool: "shell_session_read", status: r.status });
      return format(r);
    },
  };

  const shellSessionReset: Tool = {
    name: "shell_session_reset",
    description:
      "Kill and restart the persistent shell (clears cwd/env and stops any running process in it). " +
      "Use if the session is stuck or you want a clean environment.",
    mutating: true,
    async run(_args, ctx) {
      session.reset();
      ctx.log({ tool: "shell_session_reset" });
      return { ok: true, output: "Persistent shell reset — a fresh shell will start on the next command." };
    },
  };

  return [shellSession, shellSessionRead, shellSessionReset];
}

export const SHELL_SESSION_TOOL_SPECS: ToolSpec[] = [
  {
    name: "shell_session",
    description:
      "Run a command in a PERSISTENT shell whose state (current directory, environment variables, " +
      "activated virtualenv, background processes) survives across calls — unlike run_shell, which " +
      "starts fresh every time. Use when commands build on each other (e.g. `cd build` then `cmake ..`), " +
      "or to launch a long-running process (dev server, file watcher, REPL) and then poll it with " +
      "shell_session_read. On Windows the shell is PowerShell.",
    parameters: {
      type: "object",
      properties: {
        command: str("The command line to run in the persistent shell."),
        timeout_ms: { type: "integer", description: "How long to wait for it to finish before returning partial output (default 15000)." },
      },
      required: ["command"],
    },
  },
  {
    name: "shell_session_read",
    description:
      "Get more output from a command that was still running in the persistent shell (after " +
      "shell_session reported it hadn't finished). Returns the new output and whether it's done now.",
    parameters: {
      type: "object",
      properties: {
        timeout_ms: { type: "integer", description: "How long to wait for more output (default 10000)." },
      },
    },
  },
  {
    name: "shell_session_reset",
    description:
      "Restart the persistent shell from scratch — clears the working directory, environment, and any " +
      "process running inside it. Use if the session is wedged or you need a clean slate.",
    parameters: { type: "object", properties: {} },
  },
];
