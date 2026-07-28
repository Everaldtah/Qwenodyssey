import { MODEL_DEFAULTS, type Config } from "../core/config";
import { samplingForModel } from "../core/modelProfile";
import type { Provider } from "../types";
import type { ProviderConfig } from "./base";
import { OllamaProvider } from "./ollama";
import { LMStudioProvider } from "./lmstudio";
import { OpenAICompatibleEndpointProvider } from "./openaiCompatible";
import { VLLMProvider } from "./vllm";
import { LlamaCppProvider } from "./llamacpp";
import { NvidiaNimProvider } from "./nvidia";
import { OpenRouterProvider } from "./openrouter";
import { AnthropicProvider } from "./anthropic";
import execa from "execa";

/** Sensible default base URLs per provider when the config leaves it blank. */
const DEFAULT_BASE: Record<string, string> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234",
  openai: "https://api.openai.com",
  vllm: "http://localhost:8000",
  llamacpp: "http://localhost:8080",
  nvidia: "https://integrate.api.nvidia.com",
  openrouter: "https://openrouter.ai/api",
  anthropic: "https://api.anthropic.com",
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

/**
 * Resolve the OpenRouter API key without ever requiring it to live in a committed
 * file: explicit config first, then the configured env var, then OPENROUTER_API_KEY.
 */
export function resolveOpenRouterKey(config: Config): string {
  const o = config.openrouter;
  const envName = o.api_key_env || "OPENROUTER_API_KEY";
  return o.api_key || process.env[envName] || process.env.OPENROUTER_API_KEY || "";
}

// Cache the `ant` token lookup so the per-turn fallback/picker checks don't spawn
// a subprocess every time. OAuth tokens live far longer than the TTL; a 401
// forces a fresh mint (see refreshAuth in createAnthropicProvider).
let cliTokenCache: { token: string | null; at: number } = { token: null, at: 0 };
const CLI_TOKEN_TTL_MS = 60_000;

/**
 * Get an Anthropic OAuth bearer token from the `ant` CLI (the documented way to
 * use a Claude Pro/Max subscription). `ant auth print-credentials --access-token`
 * refreshes the token if needed and prints just the bearer. Best-effort: returns
 * null if `ant` isn't installed or the user isn't logged in. Cached for a minute
 * unless `force` is set (used on a 401 to re-mint an expired token).
 */
export function antPrintCredentials(force = false): string | null {
  if (!force && Date.now() - cliTokenCache.at < CLI_TOKEN_TTL_MS) return cliTokenCache.token;
  let token: string | null = null;
  for (const bin of ["ant", "ant.cmd"]) {
    try {
      const r = execa.sync(bin, ["auth", "print-credentials", "--access-token"], { timeout: 15000 });
      const tok = (r.stdout || "").trim();
      // A real bearer token is a single whitespace-free string. `ant` exits 0 even
      // when not logged in (printing a message to stderr), so guard against ever
      // treating stray output as a credential.
      if (tok && !/\s/.test(tok) && tok.length >= 20) {
        token = tok;
        break;
      }
    } catch {
      /* try the next binary name / fall through */
    }
  }
  cliTokenCache = { token, at: Date.now() };
  return token;
}

/**
 * Resolve Anthropic auth WITHOUT requiring a committed secret. Two modes:
 *  - OAuth bearer (Claude subscription): explicit config token, then the env var,
 *    then the `ant` CLI (auto-refreshing) when use_cli_auth is on.
 *  - API key (console pay-as-you-go): explicit config, then the env var.
 */
export function resolveAnthropicAuth(config: Config): { authToken: string; apiKey: string } {
  const a = config.anthropic;
  const tokenEnv = a.auth_token_env || "ANTHROPIC_AUTH_TOKEN";
  const keyEnv = a.api_key_env || "ANTHROPIC_API_KEY";
  let authToken = a.auth_token || process.env[tokenEnv] || "";
  if (!authToken && a.use_cli_auth) authToken = antPrintCredentials() || "";
  const apiKey = a.api_key || process.env[keyEnv] || "";
  return { authToken, apiKey };
}

/** Is some Anthropic credential available (OAuth token or API key)? */
export function anthropicAuthAvailable(config: Config): boolean {
  if (!config.anthropic.enabled) return false;
  const { authToken, apiKey } = resolveAnthropicAuth(config);
  return !!(authToken || apiKey);
}

/**
 * Model-aware tuning for LOCAL backends: take the decoding parameters the model
 * family's authors recommend (see core/modelProfile) and apply them wherever the
 * user left [model] at its defaults. An explicitly configured value always wins,
 * and `model.auto_tune = false` disables the whole mechanism.
 *
 * This is what makes a 9B-class local model behave: Qwen3/3.5 gets its
 * anti-repetition sampling instead of degenerate greedy decoding, qwen2.5-coder
 * keeps the near-greedy settings that maximise tool adherence, and gemma gets
 * top_k 64 — without the user tuning anything by hand.
 */
export function tuneForModel(config: Config, model: string, cfg: ProviderConfig): ProviderConfig {
  const m = config.model;
  const out: ProviderConfig = { ...cfg, think: m.think };
  if (!m.auto_tune) {
    return {
      ...out,
      topK: m.top_k,
      repeatPenalty: m.repeat_penalty,
      presencePenalty: m.presence_penalty,
    };
  }
  const s = samplingForModel(model, m.think);
  return {
    ...out,
    temperature: m.temperature === MODEL_DEFAULTS.temperature ? s.temperature : m.temperature,
    topP: m.top_p === MODEL_DEFAULTS.top_p ? s.topP : m.top_p,
    topK: m.top_k === MODEL_DEFAULTS.top_k ? s.topK ?? 0 : m.top_k,
    repeatPenalty:
      m.repeat_penalty === MODEL_DEFAULTS.repeat_penalty ? s.repeatPenalty ?? 0 : m.repeat_penalty,
    presencePenalty:
      m.presence_penalty === MODEL_DEFAULTS.presence_penalty
        ? s.presencePenalty ?? 0
        : m.presence_penalty,
  };
}

export function createProvider(config: Config): Provider {
  const m = config.model;
  if (m.provider === "nvidia") return createNvidiaProvider(config, m.model);
  if (m.provider === "openrouter") return createOpenRouterProvider(config, m.model);
  if (m.provider === "anthropic") return createAnthropicProvider(config, m.model);
  const cfg: ProviderConfig = tuneForModel(config, m.model, {
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
  });
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
  return new OllamaProvider(
    tuneForModel(config, model, {
      model,
      baseUrl:
        m.base_url && config.model.provider === "ollama" ? m.base_url : "http://localhost:11434",
      apiKey: "",
      temperature: m.temperature,
      topP: m.top_p,
      maxTokens: m.max_tokens,
      contextTokens: m.context_tokens,
      gpuLayers: m.gpu_layers,
      lowVram: m.low_vram,
      keepAlive: m.keep_alive,
    })
  );
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
    nemotronThinking: config.nvidia.nemotron_thinking,
    reasoningBudget: config.nvidia.reasoning_budget,
  });
}

/**
 * Build an OpenRouter provider for a specific hosted model, independent of the
 * configured default provider — used as the primary backend or a fallback. The
 * key is resolved from config/env (never required in a committed file).
 */
export function createOpenRouterProvider(config: Config, model: string): Provider {
  const m = config.model;
  return new OpenRouterProvider({
    model,
    baseUrl: config.openrouter.base_url || DEFAULT_BASE.openrouter,
    apiKey: resolveOpenRouterKey(config),
    temperature: m.temperature,
    topP: m.top_p,
    maxTokens: m.max_tokens,
    contextTokens: m.context_tokens,
    requestTimeoutMs: config.openrouter.request_timeout_ms,
  });
}

/**
 * Build an Anthropic (Claude) provider for a specific model, independent of the
 * configured default provider — usable as the primary brain or a fallback. Auth
 * is OAuth-first (Claude subscription via the `ant` CLI) with API-key fallback;
 * the OAuth token auto-refreshes on a 401 via the refreshAuth thunk.
 */
export function createAnthropicProvider(config: Config, model: string): Provider {
  const m = config.model;
  const { authToken, apiKey } = resolveAnthropicAuth(config);
  return new AnthropicProvider({
    model,
    baseUrl: config.anthropic.base_url || DEFAULT_BASE.anthropic,
    apiKey,
    authToken,
    // Only the CLI source can refresh; a config/env token can't be re-minted here.
    refreshAuth: config.anthropic.use_cli_auth ? () => antPrintCredentials(true) : undefined,
    temperature: m.temperature,
    topP: m.top_p,
    maxTokens: m.max_tokens,
    contextTokens: m.context_tokens,
    requestTimeoutMs: config.anthropic.request_timeout_ms,
  });
}

/**
 * Build an LM Studio provider for a specific model id, independent of the
 * configured default provider — used to switch the active backend to LM Studio
 * at runtime (model picker / fallback).
 */
export function createLmStudioProvider(config: Config, model: string): Provider {
  const m = config.model;
  return new LMStudioProvider(
    tuneForModel(config, model, {
      model,
      baseUrl: config.lmstudio.base_url || "http://localhost:1234",
      apiKey: config.lmstudio.api_key || "",
      temperature: m.temperature,
      topP: m.top_p,
      maxTokens: m.max_tokens,
      contextTokens: m.context_tokens,
    })
  );
}

export { OpenAICompatibleProvider } from "./base";
