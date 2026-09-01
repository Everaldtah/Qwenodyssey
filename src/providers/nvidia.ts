import { OpenAICompatibleProvider } from "./base";

/**
 * NVIDIA NIM cloud endpoint — OpenAI-compatible chat/completions hosted at
 * https://integrate.api.nvidia.com/v1. Serves strong models (e.g.
 * moonshotai/kimi-k2.6) that can act as Qwenodyssey's primary brain or a
 * fallback. Auth is a Bearer API key (resolved by the provider factory from
 * config/env); requests reuse the shared OpenAI-compatible implementation.
 */
export class NvidiaNimProvider extends OpenAICompatibleProvider {
  readonly name = "nvidia";

  /**
   * Kimi K2/K2.6 on NVIDIA NIM degenerates into repetition (NIM reports
   * finish_reason: "repetition") when given a `system` message — reproducible
   * across temperatures. Fold the system prompt into the user turn for those
   * models; other NIM models (llama, gpt-oss, etc.) handle system fine.
   */
  protected systemRoleSupported(): boolean {
    return !/(^|[-_/:.])(kimi|k2)/i.test(this.cfg.model);
  }

  /** Nemotron reasoning models use a different thinking toggle + reasoning_budget. */
  private isNemotron(): boolean {
    return /nemotron/i.test(this.cfg.model);
  }

  /** Models whose NIM chat template exposes a toggleable internal "thinking" mode. */
  private isThinkingModel(): boolean {
    return (
      /(^|[-_/:.])(r1|qwq|o1|o3|thinking|reason|kimi|k2)/i.test(this.cfg.model) ||
      /deepseek-(r1|v4)/i.test(this.cfg.model)
    );
  }

  /**
   * Per-model NIM request extras:
   *  - Nemotron: `chat_template_kwargs.enable_thinking` (+ reasoning_budget) — a
   *    different toggle than below. Its reasoning is returned in a separate
   *    `reasoning_content` field (which generate() drops), so the answer stays
   *    clean. Reasoning is enabled by default (matches NVIDIA's recipe).
   *  - Other thinking models (kimi, deepseek-v4, r1…): `thinking=false`, because
   *    on NIM their thinking path degenerates / leaks raw CoT into `content`.
   *  - Non-thinking models (qwen-coder, llama, gpt-oss): nothing extra.
   */
  protected extraBody(): Record<string, unknown> {
    if (this.isNemotron()) {
      const out: Record<string, unknown> = {
        chat_template_kwargs: { enable_thinking: this.cfg.nemotronThinking !== false },
      };
      // NIM's current Nemotron runner rejects the budget outright ("thinking_token_budget
      // is not yet supported by the V2 model runner" → HTTP 400), so it is sent only
      // when the user explicitly configures one.
      if (this.cfg.reasoningBudget && this.cfg.reasoningBudget > 0) out.reasoning_budget = this.cfg.reasoningBudget;
      return out;
    }
    if (this.cfg.disableThinking !== false && this.isThinkingModel()) {
      return { chat_template_kwargs: { thinking: false } };
    }
    return {};
  }
}
