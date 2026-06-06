import { OpenAICompatibleProvider } from "./base";

/**
 * OpenRouter cloud endpoint — OpenAI-compatible chat/completions hosted at
 * https://openrouter.ai/api/v1. It aggregates many providers behind one key, so
 * a single OpenRouter key can serve a strong primary brain (e.g.
 * moonshotai/kimi-k2.6) plus fallbacks. Auth is a Bearer API key (resolved by
 * the provider factory from config/env); requests reuse the shared
 * OpenAI-compatible implementation, with OpenRouter's optional ranking headers.
 */
export class OpenRouterProvider extends OpenAICompatibleProvider {
  readonly name = "openrouter";

  /** OpenRouter recommends HTTP-Referer / X-Title for app attribution (optional). */
  protected headers(): Record<string, string> {
    return {
      ...super.headers(),
      "HTTP-Referer": "https://github.com/Everaldtah/Qwenodyssey",
      "X-Title": "Qwenodyssey",
    };
  }
}
