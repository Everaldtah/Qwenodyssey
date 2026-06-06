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

  /** Models whose NIM chat template exposes a toggleable internal "thinking" mode. */
  private isThinkingModel(): boolean {
    return (
      /(^|[-_/:.])(r1|qwq|o1|o3|thinking|reason|kimi|k2)/i.test(this.cfg.model) ||
      /deepseek-(r1|v4)/i.test(this.cfg.model)
    );
  }

  /**
   * For thinking models (kimi, deepseek-v4, r1…), turning the chain-of-thought
   * OFF (`chat_template_kwargs.thinking=false`) gives clean, stable direct
   * answers — on NIM the thinking path is what degenerates / leaks raw CoT into
   * `content`. Only sent for thinking models; non-thinking NIM models (llama,
   * qwen-coder, gpt-oss) get nothing extra.
   */
  protected extraBody(): Record<string, unknown> {
    if (this.cfg.disableThinking !== false && this.isThinkingModel()) {
      return { chat_template_kwargs: { thinking: false } };
    }
    return {};
  }
}
