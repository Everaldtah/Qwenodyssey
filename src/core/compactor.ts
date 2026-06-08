/**
 * Context-window management: estimate how much of the model's context the chat
 * history is using and, when it gets close to the budget, COMPACT the oldest
 * turns into a dense summary so long sessions don't overflow (or silently drop
 * the system prompt). Critical for small local models with modest context.
 *
 * Clean-room implementation — inspired by the auto-compact / `/compact` UX of
 * Claude-Code-class agents, but written from scratch for Qwenodyssey.
 */
import type { Message, Provider } from "../types";

/** Rough token count of the whole history using the provider's tokenizer. */
export function historyTokens(messages: Message[], provider: Provider): number {
  let n = 0;
  for (const m of messages) {
    n += provider.countTokens(m.content || "");
    if (m.tool_calls) for (const c of m.tool_calls) n += provider.countTokens(JSON.stringify(c.arguments || {})) + 6;
    n += 4; // per-message framing overhead
  }
  return n;
}

/**
 * Should we auto-compact before the next turn? True once the history is within
 * `headroom` tokens of the usable budget (context minus the answer allowance).
 */
export function shouldCompact(
  messages: Message[],
  provider: Provider,
  opts: { contextTokens: number; maxTokens: number }
): boolean {
  const usable = Math.max(2000, opts.contextTokens - opts.maxTokens - 512);
  return historyTokens(messages, provider) >= Math.floor(usable * 0.85);
}

const MARK = "\n\n[CONVERSATION SO FAR — earlier turns were compacted to save context]\n";

function truncate(s: string, n: number): string {
  s = s || "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Index (into messages) of the start of the Kth-from-last user turn, or -1. */
function recentCutIndex(messages: Message[], keepUserTurns: number): number {
  const userIdx: number[] = [];
  for (let i = 1; i < messages.length; i++) if (messages[i].role === "user") userIdx.push(i);
  if (userIdx.length <= keepUserTurns) return -1;
  return userIdx[userIdx.length - keepUserTurns];
}

export interface CompactResult {
  compacted: boolean;
  removed: number;
  summary?: string;
  /** New message array to replace the old one with (when compacted). */
  newMessages?: Message[];
}

/**
 * Summarize everything between the system prompt and the last `keepUserTurns`
 * user turns into a memo folded into the system message. Cutting on a user-turn
 * boundary guarantees we never split an assistant(tool_calls)→tool-result group,
 * which would otherwise produce an invalid request.
 */
export async function compactHistory(
  messages: Message[],
  provider: Provider,
  opts: { keepUserTurns: number }
): Promise<CompactResult> {
  if (messages.length === 0 || messages[0].role !== "system") return { compacted: false, removed: 0 };
  const cut = recentCutIndex(messages, opts.keepUserTurns);
  if (cut < 0) return { compacted: false, removed: 0 };

  const system = messages[0];
  const middle = messages.slice(1, cut);
  const recent = messages.slice(cut);
  if (middle.length === 0) return { compacted: false, removed: 0 };

  const transcript = middle
    .map((m) => {
      if (m.role === "tool") return `TOOL(${m.name}) → ${truncate(m.content, 400)}`;
      if (m.tool_calls?.length)
        return `ASSISTANT called ${m.tool_calls.map((c) => c.name).join(", ")}${m.content ? " — " + truncate(m.content, 200) : ""}`;
      return `${m.role.toUpperCase()}: ${truncate(m.content, 900)}`;
    })
    .join("\n");

  const prompt: Message[] = [
    {
      role: "system",
      content:
        "You compress a coding-assistant conversation into a dense memo so it can continue with less " +
        "context. PRESERVE: the user's goals and decisions, important facts, exact file paths/commands, " +
        "what was already done, tool results that still matter, and any unfinished tasks. Drop chit-chat " +
        "and resolved detail. Output plain text, under 25 lines, no preamble, no code fences.",
    },
    { role: "user", content: "Compress this earlier conversation:\n\n" + transcript },
  ];

  let summary = "";
  try {
    const res = await provider.generate(prompt, { temperature: 0.2, max_tokens: 700 });
    summary = (res.text || "").trim();
  } catch {
    return { compacted: false, removed: 0 };
  }
  if (!summary) return { compacted: false, removed: 0 };

  // Fold the memo into the system message (idempotent across repeated compactions).
  const baseSys = system.content.split("\n\n[CONVERSATION SO FAR")[0];
  const newSystem: Message = { role: "system", content: baseSys + MARK + summary };
  return { compacted: true, removed: middle.length, summary, newMessages: [newSystem, ...recent] };
}
