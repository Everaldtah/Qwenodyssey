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
}
