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
}
