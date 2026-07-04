/**
 * `think` — a scratchpad tool for deliberation between actions. Small models
 * benefit from an explicit place to reason: without one they either skip
 * thinking (and act wrong) or leak chain-of-thought into their answer. A think
 * call spends a THINKING turn (agent.max_thinking_turns), not a tool step, so
 * deliberating never starves the budget for real work — see runAssistantTurn.
 *
 * The thought is preserved in history via the tool_call arguments; the tool
 * result is a short ack so the thought isn't fed back twice.
 *
 * Clean-room implementation — inspired by the "think" tool pattern published
 * for Claude-class agents, written from scratch for Qwenodyssey.
 */
import chalk from "chalk";
import type { Tool, ToolSpec } from "../types";

export const THINK_TOOL_SPEC: ToolSpec = {
  name: "think",
  description:
    "Pause and reason privately before your next action. Use it to analyse a tool result, weigh " +
    "options, or plan the next step when the task is tricky. The thought is not shown as your " +
    "answer and runs nothing. After thinking, make the actual tool call or give your final answer.",
  parameters: {
    type: "object",
    properties: {
      thought: { type: "string", description: "Your reasoning about what you learned and what to do next." },
    },
    required: ["thought"],
  },
};

export function createThinkTool(): Tool {
  return {
    name: "think",
    description: THINK_TOOL_SPEC.description,
    mutating: false,
    async run(args, ctx) {
      const thought = String(args.thought ?? "").trim();
      if (!thought) {
        return { ok: false, output: "Provide `thought` — the reasoning you want to record." };
      }
      // Show the deliberation the way inline <think> reasoning is shown, so the
      // user sees the model working rather than an opaque pause.
      console.log(chalk.magenta("qwen ⟂ thinking"));
      console.log(chalk.gray("  " + thought.split("\n").join("\n  ")) + "\n");
      ctx.log({ tool: "think", chars: thought.length });
      return { ok: true, output: "Thought noted. Now take the next step: call the tool you need, or give your final answer." };
    },
  };
}
