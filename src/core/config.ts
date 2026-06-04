/**
 * Configuration: load/save .qwenodyssey/config.toml with defaults + validation.
 */
import * as fs from "fs";
import * as path from "path";
import TOML from "@iarna/toml";
import { z } from "zod";

export const WORKSPACE_DIR = ".qwenodyssey";

const ModelConfig = z.object({
  provider: z
    .enum(["ollama", "lmstudio", "openai", "vllm", "llamacpp"])
    .default("ollama"),
  model: z.string().default("qwen2.5:7b"),
  // Used automatically if `model` isn't installed at launch, or if a request
  // fails because the model is unavailable. Empty disables fallback.
  fallback_model: z.string().default("deepseek-r1:7b"),
  base_url: z.string().default("http://localhost:11434"),
  api_key: z.string().default(""),
  temperature: z.number().default(0.2),
  top_p: z.number().default(0.9),
  // Generous output budget so deep reasoning / long <think> chains aren't cut off.
  max_tokens: z.number().default(8192),
  context_tokens: z.number().default(8192),
});

const AgentConfig = z.object({
  max_retries: z.number().default(4),
  auto_apply: z.boolean().default(false),
  auto_test: z.boolean().default(true),
  review_before_apply: z.boolean().default(true),
  small_model_mode: z.boolean().default(true),
});

const ToolsConfig = z.object({
  allow_shell: z.boolean().default(true),
  confirm_destructive: z.boolean().default(true),
  sandbox: z.boolean().default(true),
});

const MemoryConfig = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default(".qwenodyssey/memory"),
});

/** Obsidian-style long-term knowledge vault + retrieval (RAG). */
const KnowledgeConfig = z.object({
  enabled: z.boolean().default(true),
  // Empty => a global vault at ~/.qwenodyssey/knowledge (permanent, cross-project).
  path: z.string().default(""),
  // Pull relevant notes into context automatically before each turn.
  auto_recall: z.boolean().default(true),
  recall_k: z.number().default(4),
  // Ollama embedding model for semantic search; falls back to keyword if absent.
  embed_model: z.string().default("nomic-embed-text"),
});

/** Internet search + page fetch. */
const WebConfig = z.object({
  enabled: z.boolean().default(true),
  provider: z.enum(["duckduckgo", "tavily", "brave", "searxng"]).default("duckduckgo"),
  api_key: z.string().default(""),
  searxng_url: z.string().default(""),
  max_results: z.number().default(5),
  fetch_chars: z.number().default(8000),
});

export const ConfigSchema = z.object({
  model: ModelConfig.default({}),
  agent: AgentConfig.default({}),
  tools: ToolsConfig.default({}),
  memory: MemoryConfig.default({}),
  knowledge: KnowledgeConfig.default({}),
  web: WebConfig.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

export function workspacePath(cwd: string): string {
  return path.join(cwd, WORKSPACE_DIR);
}

export function configPath(cwd: string): string {
  return path.join(workspacePath(cwd), "config.toml");
}

export function loadConfig(cwd: string): Config {
  const file = configPath(cwd);
  if (!fs.existsSync(file)) {
    return defaultConfig();
  }
  try {
    const raw = TOML.parse(fs.readFileSync(file, "utf-8"));
    return ConfigSchema.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ${file}: ${(err as Error).message}. ` +
        `Run "qwenodyssey init --force" to regenerate it.`
    );
  }
}

export function saveConfig(cwd: string, config: Config): void {
  const dir = workspacePath(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const validated = ConfigSchema.parse(config);
  fs.writeFileSync(
    configPath(cwd),
    TOML.stringify(validated as unknown as TOML.JsonMap),
    "utf-8"
  );
}

/** Read a dotted key like "model.provider". */
export function getByPath(config: Config, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<any>((acc, key) => (acc == null ? acc : acc[key]), config);
}

/** Set a dotted key, coercing simple scalar types to match the existing value. */
export function setByPath(config: Config, dotted: string, value: string): Config {
  const parts = dotted.split(".");
  const clone: any = JSON.parse(JSON.stringify(config));
  let node = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    if (node[parts[i]] == null || typeof node[parts[i]] !== "object") {
      node[parts[i]] = {};
    }
    node = node[parts[i]];
  }
  const leaf = parts[parts.length - 1];
  const prev = node[leaf];
  node[leaf] = coerce(value, prev);
  return ConfigSchema.parse(clone);
}

function coerce(value: string, prev: unknown): unknown {
  if (typeof prev === "number") {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(`Expected a number, got "${value}"`);
    return n;
  }
  if (typeof prev === "boolean") {
    if (/^(true|1|yes|on)$/i.test(value)) return true;
    if (/^(false|0|no|off)$/i.test(value)) return false;
    throw new Error(`Expected a boolean, got "${value}"`);
  }
  return value;
}
