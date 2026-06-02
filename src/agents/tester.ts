import type { RepoInfo, TestResult } from "../types";
import type { ToolRegistry } from "../tools/registry";

/**
 * Run the project's detected test command. Never fakes success: if no command
 * is detected, returns ran=false so the caller can decide what to do.
 */
export async function runTests(
  tools: ToolRegistry,
  repo: RepoInfo,
  explicitCommand?: string
): Promise<TestResult> {
  const command = explicitCommand || repo.testCommand;
  if (!command) {
    return { ran: false, passed: false, output: "No test command detected for this project." };
  }
  const res = await tools.run("run_shell", { command });
  return {
    ran: true,
    passed: res.ok,
    command,
    output: res.output,
  };
}
