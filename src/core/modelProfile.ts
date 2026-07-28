/**
 * Model profiles: what a given model IS, and how it should be sampled.
 *
 * Small local models (≤ ~9B) live or die by their decoding parameters. Running
 * Qwen3/3.5 greedily makes it repeat itself; running qwen2.5-coder hot makes it
 * botch tool calls. Rather than one global temperature for every backend, we
 * classify the model by family and hand back the sampling its authors actually
 * recommend, split by whether the model is thinking this turn.
 *
 * Everything here is derived from the model NAME alone (no network calls), so it
 * works for Ollama tags, LM Studio keys and hosted refs alike.
 */

/** How the harness decides whether a thinking-capable model should think. */
export type ThinkMode = "auto" | "always" | "never";

export interface SamplingProfile {
  /** Base temperature for one-shot generation (edit pipeline, summaries, …). */
  temperature: number;
  topP: number;
  topK?: number;
  presencePenalty?: number;
  /** Ollama `repeat_penalty` — the main anti-loop lever for small models. */
  repeatPenalty?: number;
  /**
   * Floor for agent TOOL turns. Tool turns want determinism, but families that
   * degenerate at temperature 0 (Qwen3, R1, QwQ) need a little heat regardless.
   */
  minTurnTemp: number;
}

export interface ModelProfile {
  /** Family slug, e.g. "qwen3" / "qwen2.5-coder" / "deepseek-r1". */
  family: string;
  /** Trained to deliberate with an internal chain-of-thought. */
  reasoning: boolean;
  /**
   * Thinking can be toggled per request (Qwen3/3.5 hybrids: Ollama `think`,
   * or the `/no_think` soft switch on OpenAI-compatible servers). Pure reasoning
   * models (R1, QwQ) always think and must NOT be sent a disable flag.
   */
  hybridThinking: boolean;
  /** What think mode "auto" resolves to for this family. */
  thinkByDefault: boolean;
  /** Recommended sampling while thinking / while not thinking. */
  thinking: SamplingProfile;
  nonThinking: SamplingProfile;
  /** Context window the family can comfortably use (num_ctx hint). */
  contextSuggestion: number;
}

/** Generic decoding for a non-reasoning instruct model. */
const GENERIC: SamplingProfile = { temperature: 0.2, topP: 0.9, minTurnTemp: 0 };

/** Deliberating models loop at temperature 0; ~0.6 is the published guidance. */
const REASONING_SAMPLING: SamplingProfile = {
  temperature: 0.6,
  topP: 0.95,
  minTurnTemp: 0.6,
};

/**
 * Qwen3 / Qwen3.5 THINKING mode — the sampling Qwen publishes for these hybrids.
 * Greedy decoding is explicitly discouraged: it causes endless repetition.
 */
const QWEN3_THINKING: SamplingProfile = {
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  repeatPenalty: 1.05,
  minTurnTemp: 0.6,
};

/**
 * Qwen3 / Qwen3.5 NON-thinking mode — what the agent loop uses by default, since
 * a coding/shell harness wants fast, tool-shaped turns and already scaffolds its
 * own reasoning (DEEP_THINK + the `think` tool). The presence penalty is Qwen's
 * recommended anti-repetition setting for this mode; the 0.3 turn floor keeps
 * tool calls near-deterministic without tipping into a greedy loop.
 */
const QWEN3_NON_THINKING: SamplingProfile = {
  temperature: 0.7,
  topP: 0.8,
  topK: 20,
  presencePenalty: 1.5,
  repeatPenalty: 1.05,
  minTurnTemp: 0.3,
};

/**
 * Qwen2.x (incl. the coder tunes): stable under greedy decoding, which is the
 * best setting for tool adherence, so the turn floor stays at 0.
 */
const QWEN2_SAMPLING: SamplingProfile = {
  temperature: 0.2,
  topP: 0.8,
  topK: 20,
  repeatPenalty: 1.05,
  minTurnTemp: 0,
};

/** Google's published defaults for Gemma. */
const GEMMA_SAMPLING: SamplingProfile = {
  temperature: 0.2,
  topP: 0.95,
  topK: 64,
  repeatPenalty: 1.05,
  minTurnTemp: 0,
};

function profileOf(
  family: string,
  opts: Partial<ModelProfile> & { thinking?: SamplingProfile; nonThinking?: SamplingProfile }
): ModelProfile {
  return {
    family,
    reasoning: false,
    hybridThinking: false,
    thinkByDefault: false,
    thinking: REASONING_SAMPLING,
    nonThinking: GENERIC,
    contextSuggestion: 16384,
    ...opts,
  };
}

/**
 * Classify a model by name. Order matters: the most specific families are tested
 * first (qwen3 before the generic qwen rule, deepseek-r1 before deepseek).
 */
export function modelProfile(model: string): ModelProfile {
  const m = (model || "").toLowerCase();

  // ── Qwen 3 / 3.5 (incl. 3.5 9B) — hybrid thinking ────────────────────────
  // Matches qwen3, qwen-3, qwen3.5, qwen_3.5-9b, qwen3.5-coder…
  if (/qwen[\s._-]?3(\.\d+)?/.test(m)) {
    return profileOf(/coder/.test(m) ? "qwen3-coder" : "qwen3", {
      reasoning: true,
      hybridThinking: true,
      // Auto = think OFF: for coding/shell turns this is markedly faster and
      // sticks to tool calls better. The harness still reasons via its own
      // scaffold, and `model.think = "always"` restores native deliberation.
      thinkByDefault: false,
      thinking: QWEN3_THINKING,
      nonThinking: QWEN3_NON_THINKING,
      contextSuggestion: 32768,
    });
  }

  // ── DeepSeek-R1 / QwQ — always-thinking reasoners ────────────────────────
  if (/deepseek[\s._-]?r1/.test(m) || /(^|[-_/:.])r1([-_/:.]|$)/.test(m)) {
    return profileOf("deepseek-r1", {
      reasoning: true,
      thinkByDefault: true,
      thinking: REASONING_SAMPLING,
      nonThinking: REASONING_SAMPLING,
      contextSuggestion: 32768,
    });
  }
  if (/qwq/.test(m)) {
    return profileOf("qwq", {
      reasoning: true,
      thinkByDefault: true,
      contextSuggestion: 32768,
    });
  }

  // ── Qwen 2.x ─────────────────────────────────────────────────────────────
  if (/qwen/.test(m)) {
    return profileOf(/coder/.test(m) ? "qwen2.5-coder" : "qwen2.5", {
      thinking: QWEN2_SAMPLING,
      nonThinking: QWEN2_SAMPLING,
      contextSuggestion: 32768,
    });
  }

  // ── Other deliberating models (hosted or local) ──────────────────────────
  // Keeps parity with the classifier this replaced: kimi/k2, nemotron, o1/o3,
  // and anything self-describing as thinking/reasoning.
  if (/(^|[-_/:.])(o1|o3|kimi|k2|nemotron|thinking|reason)/.test(m) || /deepseek[\s._-]?v[34]/.test(m)) {
    return profileOf("reasoning", {
      reasoning: true,
      thinkByDefault: true,
      contextSuggestion: 32768,
    });
  }

  // ── Gemma ────────────────────────────────────────────────────────────────
  if (/gemma/.test(m)) {
    return profileOf("gemma", {
      thinking: GEMMA_SAMPLING,
      nonThinking: GEMMA_SAMPLING,
      contextSuggestion: 32768,
    });
  }

  // ── Everything else: llama / mistral / codestral / phi / granite / … ─────
  return profileOf("generic", { thinking: GENERIC, nonThinking: GENERIC });
}

/**
 * Should this model expose a chain-of-thought this turn?
 * Returns `undefined` for models with no thinking mode at all, so callers know
 * to omit the flag entirely rather than sending `think: false` (which some
 * backends reject for non-thinking models).
 */
export function resolveThinking(
  profile: ModelProfile,
  mode: ThinkMode = "auto"
): boolean | undefined {
  if (!profile.reasoning) return undefined;
  if (mode === "always") return true;
  // A pure reasoning model always thinks — asking it not to is not supported.
  if (mode === "never") return profile.hybridThinking ? false : true;
  return profile.thinkByDefault;
}

/** The sampling profile that applies given the resolved thinking state. */
export function samplingFor(profile: ModelProfile, thinking: boolean | undefined): SamplingProfile {
  return thinking ? profile.thinking : profile.nonThinking;
}

/**
 * Convenience for callers that only have a model name and the configured think
 * mode: the sampling actually in force.
 */
export function samplingForModel(model: string, mode: ThinkMode = "auto"): SamplingProfile {
  const p = modelProfile(model);
  return samplingFor(p, resolveThinking(p, mode));
}

/** Trained to deliberate with an internal chain-of-thought. */
export function isReasoningModel(model: string): boolean {
  return modelProfile(model).reasoning;
}
