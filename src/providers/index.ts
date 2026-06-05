import type { Config } from "../core/config";
import type { Provider } from "../types";
import type { ProviderConfig } from "./base";
import { OllamaProvider } from "./ollama";
import { LMStudioProvider } from "./lmstudio";
import { OpenAICompatibleEndpointProvider } from "./openaiCompatible";
import { VLLMProvider } from "./vllm";
import { LlamaCppProvider } from "./llamacpp";

/** Sensible default base URLs per provider when the config leaves it blank. */
const DEFAULT_BASE: Record<string, string> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234",
  openai: "https://api.openai.com",
  vllm: "http://localhost:8000",
  llamacpp: "http://localhost:8080",
};

export function createProvider(config: Config): Provider {
  const m = config.model;
  const cfg: ProviderConfig = {
    model: m.model,
    baseUrl: m.base_url || DEFAULT_BASE[m.provider] || "http://localhost:11434",
    apiKey: m.api_key || process.env.QWENODYSSEY_API_KEY || "",
    temperature: m.temperature,
    topP: m.top_p,
    maxTokens: m.max_tokens,
    contextTokens: m.context_tokens,
    gpuLayers: m.gpu_layers,
    lowVram: m.low_vram,
    keepAlive: m.keep_alive,
  };
  switch (m.provider) {
    case "ollama":
      return new OllamaProvider(cfg);
    case "lmstudio":
      return new LMStudioProvider(cfg);
    case "openai":
      return new OpenAICompatibleEndpointProvider(cfg);
    case "vllm":
      return new VLLMProvider(cfg);
    case "llamacpp":
      return new LlamaCppProvider(cfg);
    default:
      return new OllamaProvider(cfg);
  }
}

/**
 * Build an LM Studio provider for a specific model id, independent of the
 * configured default provider — used to switch the active backend to LM Studio
 * at runtime (model picker / fallback).
 */
export function createLmStudioProvider(config: Config, model: string): Provider {
  const m = config.model;
  return new LMStudioProvider({
    model,
    baseUrl: config.lmstudio.base_url || "http://localhost:1234",
    apiKey: config.lmstudio.api_key || "",
    temperature: m.temperature,
    topP: m.top_p,
    maxTokens: m.max_tokens,
    contextTokens: m.context_tokens,
  });
}

export { OpenAICompatibleProvider } from "./base";
