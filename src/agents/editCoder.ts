/**
 * Edit-block coder — the upgraded code-generation agent for small models.
 *
 * Unlike the legacy JSON-diff coder (agents/coder.ts), this agent:
 *   - asks the model for SEARCH/REPLACE blocks (which small models get right far
 *     more often than unified diffs or whole-file JSON),
 *   - drives the reliable edit pipeline (best-of-N + apply + verify + repair),
 *   - injects compiler/test feedback verbatim on repair rounds.
 *
 * The legacy coder is kept for the JSON pipeline; the orchestrator selects this
 * one when config.agent.edit_protocol === "blocks" (the new default for small
 * models).
 */
import type { Provider, Message } from "../types";
import { loadPrompt, render } from "../core/promptLoader";
import { runEditPipeline, type EditPipelineResult, type PipelineEvent } from "../core/editPipeline";

export interface EditCoderOptions {
  provider: Provider;
  task: string;
  context: string;
  root: string;
  resolve: (rel: string) => string;
  /** best-of-N candidate count (config.agent.candidates). */
  candidates: number;
  /** self-repair rounds (config.agent.max_retries). */
  maxRepairRounds: number;
  runVerify: boolean;
  verifyOnly?: ("typecheck" | "lint" | "test" | "build")[];
  /** Temperature for the first sample; later samples nudge up for diversity. */
  baseTemperature?: number;
  onEvent?: (e: PipelineEvent) => void;
}

/**
 * Build the conversation for one generation. On repair rounds, `feedback`
 * (compiler/test digest) is appended so the model fixes the real failure.
 */
function buildMessages(opts: EditCoderOptions, attempt: number, feedback?: string): Message[] {
  const userPrompt = render(loadPrompt("coder_blocks"), {
    task: opts.task,
    context: opts.context,
  });

  const messages: Message[] = [
    { role: "system", content: loadPrompt("system") },
    { role: "user", content: userPrompt },
  ];

  if (feedback) {
    messages.push({
      role: "user",
      content:
        "[system] Your previous edits were applied but the checks FAILED with the output below. " +
        "Fix the cause with new SEARCH/REPLACE blocks. The SEARCH text must match the CURRENT file " +
        "contents exactly (your earlier edits are already applied).\n\n" +
        feedback,
    });
  } else if (attempt > 0) {
    // Diversity nudge for additional best-of-N samples (no feedback yet).
    messages.push({
      role: "user",
      content: "[system] Provide an alternative implementation approach for the same task.",
    });
  }

  return messages;
}

export async function codeWithBlocks(opts: EditCoderOptions): Promise<EditPipelineResult> {
  const baseTemp = opts.baseTemperature ?? 0.2;

  const generate = async (attempt: number, feedback?: string): Promise<string> => {
    const messages = buildMessages(opts, attempt, feedback);
    // Raise temperature slightly for later best-of-N samples to diversify, but
    // keep repair rounds (feedback present) low-temp for precision.
    const temperature = feedback ? 0.1 : Math.min(0.7, baseTemp + attempt * 0.15);
    const res = await opts.provider.generate(messages, { temperature });
    return res.text || "";
  };

  return runEditPipeline(generate, {
    root: opts.root,
    resolve: opts.resolve,
    candidates: opts.candidates,
    maxRepairRounds: opts.maxRepairRounds,
    runVerify: opts.runVerify,
    verifyOnly: opts.verifyOnly,
    onEvent: opts.onEvent,
  });
}
