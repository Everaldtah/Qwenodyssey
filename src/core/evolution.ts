/**
 * Evolution engine: the agent gets smarter by learning from its mistakes.
 *
 * After each turn we collect failure signals (tools that errored, retries, the
 * step-limit being hit). When a turn went badly, the engine asks the model to
 * reflect and distill ONE durable, reusable lesson, then stores it in the
 * knowledge vault tagged "lesson". Those lessons are auto-recalled in future
 * turns (semantic retrieval), so the same mistake isn't repeated — learning
 * accumulates across sessions without retraining weights.
 */
import type { GenerateResult, Message, ModelOptions } from "../types";
import type { KnowledgeBase, Note } from "./knowledge";

export interface TurnSignals {
  userMessage: string;
  failures: string[];
  finalAnswer: string;
  stepLimitHit: boolean;
}

type Generate = (messages: Message[], options?: ModelOptions) => Promise<GenerateResult>;

export class EvolutionEngine {
  constructor(
    private kb: KnowledgeBase,
    private generate: Generate,
    private opts: { enabled: boolean; reflectOnFailure: boolean }
  ) {}

  /** Saved lessons (tag "lesson"), newest first. */
  lessons(): Note[] {
    return this.kb.list().filter((n) => n.tags.includes("lesson"));
  }

  /**
   * Reflect on a finished turn and, if there's something to learn, save a
   * lesson. Returns the lesson title when one was saved, else null. Cheap: one
   * short JSON-only model call, and only when the turn actually had trouble (so
   * smooth turns cost nothing).
   */
  async reflect(turn: TurnSignals): Promise<string | null> {
    if (!this.opts.enabled) return null;
    const troubled = turn.failures.length > 0 || turn.stepLimitHit;
    if (this.opts.reflectOnFailure && !troubled) return null;

    const sys =
      "You are Qwenodyssey reflecting on the turn you just finished, in order to get smarter. " +
      "From the problems and the final outcome, extract ONE concise, GENERAL, reusable lesson that " +
      "would prevent repeating the mistake next time — name the correct tool/command/approach. " +
      'Reply with ONLY JSON: {"title":"short title","lesson":"1-2 sentence rule"} ' +
      'or {"skip":true} if nothing durable is worth saving.';
    const user =
      `User asked: ${turn.userMessage.slice(0, 300)}\n\n` +
      `Problems this turn:\n${turn.failures.slice(0, 8).join("\n").slice(0, 1500) || "(hit the tool-step limit without resolving)"}\n\n` +
      `Final answer: ${turn.finalAnswer.slice(0, 400)}`;

    let res: GenerateResult;
    try {
      res = await this.generate(
        [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        { temperature: 0.2, max_tokens: 250, json: true }
      );
    } catch {
      return null;
    }

    const parsed = safeJson(res.text);
    if (!parsed || parsed.skip || !parsed.lesson) return null;
    const title = String(parsed.title || "lesson").slice(0, 80).trim();
    try {
      await this.kb.write({
        title: `Lesson: ${title}`,
        content: String(parsed.lesson).trim(),
        tags: ["lesson", "evolution"],
      });
    } catch {
      return null;
    }
    return title;
  }
}

/** Extract the first JSON object from a model reply, tolerating stray text. */
function safeJson(text: string): any {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}
