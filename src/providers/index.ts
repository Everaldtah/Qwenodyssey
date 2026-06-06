import type { Config } from "../core/config";
import type { Provider } from "../types";
import type { ProviderConfig } from "./base";
import { OllamaProvider } from "./ollama";
import { LMStudioProvider } from "./lmstudio";
import { OpenAICompatibleEndpointProvider } from "./openaiCompatible";
import { VLLMProvider } from "./vllm";
import { LlamaCppProvider } from "./llamacpp";
import { NvidiaNimProvider } from "./nvidia";

/** Sensible default base URLs per provider when the config leaves it blank. */
const DEFAULT_BASE: Record<string, string> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234",
  openai: "https://api.openai.com",
  vllm: "http://localhost:8000",
  llamacpp: "http://localhost:8080",
  nvidia: "https://integrate.api.nvidia.com",
};

/**
 * Resolve the NVIDIA NIM API key without ever requiring it to live in a committed
 * file: explicit config first, then the configured env var, then NVIDIA_API_KEY.
 */
export function resolveNvidiaKey(config: Config): string {
  const n = config.nvidia;
  const envName = n.api_key_env || "NVIDIA_API_KEY";
  return n.api_key || process.env[envName] || process.env.NVIDIA_API_KEY || "";
}

export function createProvider(config: Config): Provider {
  const m = config.model;
  if (m.provider === "nvidia") return createNvidiaProvider(config, m.model);
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
 * Build an Ollama provider for a specific tag, independent of the configured
 * default provider. Used when switching the active backend to Ollama at runtime
 * (model picker / fallback) while the primary provider is something else.
 */
export function createOllamaProvider(config: Config, model: string): Provider {
  const m = config.model;
  return new OllamaProvider({
    model,
    baseUrl: m.base_url && config.model.provider === "ollama" ? m.base_url : "http://localhost:11434",
    apiKey: "",
    temperature: m.temperature,
    topP: m.top_p,
    maxTokens: m.max_tokens,
    contextTokens: m.context_tokens,
    gpuLayers: m.gpu_layers,
    lowVram: m.low_vram,
    keepAlive: m.keep_alive,
  });
}

/**
 * Build an NVIDIA NIM provider for a specific hosted model, independent of the
 * configured default provider — used as the primary backend or a fallback. The
 * key is resolved from config/env (never required in a committed file).
 */
export function createNvidiaProvider(config: Config, model: string): Provider {
  const m = config.model;
  return new NvidiaNimProvider({
    model,
    baseUrl: config.nvidia.base_url || DEFAULT_BASE.nvidia,
    apiKey: resolveNvidiaKey(config),
    temperature: m.temperature,
    topP: m.top_p,
    maxTokens: m.max_tokens,
    contextTokens: m.context_tokens,
    disableThinking: config.nvidia.disable_thinking,
    requestTimeoutMs: config.nvidia.request_timeout_ms,
  });
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
