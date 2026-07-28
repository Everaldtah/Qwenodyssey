/**
 * Configuration: load/save .qwenodyssey/config.toml with defaults + validation.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import TOML from "@iarna/toml";
import { z } from "zod";

export const WORKSPACE_DIR = ".qwenodyssey";

const ModelConfig = z.object({
  provider: z
    .enum(["ollama", "lmstudio", "openai", "vllm", "llamacpp", "nvidia", "openrouter", "anthropic"])
    .default("ollama"),
  model: z.string().default("qwen3.5:9b"),
  // Ordered fallback chain: tried in turn if `model` isn't installed at launch,
  // or when a request fails because the active model is unavailable. The first
  // installed/working one wins. Empty list disables fallback.
  // Refs are bare Ollama tags, "lmstudio:<key>", "nvidia:<model>" (cloud NIM), or
  // "openrouter:<model>" (cloud OpenRouter) — cloud refs are only used when the
  // matching API key is configured; skipped otherwise.
  fallback_models: z
    .array(z.string())
    .default([
      "nvidia:deepseek-ai/deepseek-v4-pro",
      "nvidia:moonshotai/kimi-k2.6",
      "qwen2.5-coder:7b",
      "deepseek-r1:7b",
      "igorls/gemma-4-12B-it-heretic-GGUF",
    ]),
  base_url: z.string().default("http://localhost:11434"),
  api_key: z.string().default(""),
  temperature: z.number().default(0.2),
  top_p: z.number().default(0.9),
  // Sampling knobs that matter most for SMALL local models. Left at 0 they are
  // omitted from the request and the model-profile tuner fills in the values the
  // model's authors recommend (see auto_tune below and src/core/modelProfile.ts).
  // Set any of them explicitly to pin it and opt that knob out of auto-tuning.
  top_k: z.number().default(0),
  repeat_penalty: z.number().default(0),
  presence_penalty: z.number().default(0),
  // Model-aware tuning: detect the model family (qwen3/3.5, qwen2.5-coder,
  // deepseek-r1, gemma…) and apply its recommended decoding parameters wherever
  // the settings above are still at their defaults. Turn off to use the literal
  // config values for every model.
  auto_tune: z.boolean().default(true),
  // Chain-of-thought policy for models that HAVE one:
  //   auto   = per family — hybrids (Qwen3/3.5) run with thinking OFF for fast,
  //            tool-shaped coding/shell turns; pure reasoners (R1, QwQ) think.
  //   always = always deliberate (slower, better on hard one-shot problems)
  //   never  = disable thinking wherever the model supports being turned off.
  think: z.enum(["auto", "always", "never"]).default("auto"),
  // GPU acceleration (Ollama). -1 = AUTO: load as many layers onto the GPU as
  // fit in VRAM and run the overflow on CPU/RAM — i.e. automatic offload when
  // the model + context/KV cache is too large for VRAM. Set a positive number
  // to force a layer count; 0 = CPU only.
  gpu_layers: z.number().default(-1),
  // Shrink GPU working buffers so bigger models/contexts still fit (Ollama low_vram).
  low_vram: z.boolean().default(false),
  // How long Ollama keeps the model resident in VRAM between turns.
  keep_alive: z.string().default("30m"),
  // Generous output budget so deep reasoning / long <think> chains aren't cut off.
  max_tokens: z.number().default(8192),
  // Ollama context window (num_ctx). 16384 holds far more code/docs than the
  // 4096 Ollama default; raise toward the model's max (qwen2.5 32K, deepseek-r1
  // & gemma-12B ~128K) if you have the RAM/VRAM for the larger KV cache.
  context_tokens: z.number().default(16384),
});

export type ModelSettings = z.infer<typeof ModelConfig>;

/**
 * The built-in [model] defaults. Auto-tuning only fills in a knob that still
 * equals its default, so anything a user (or `qwenodyssey config set`) writes
 * explicitly always wins over the model profile.
 */
export const MODEL_DEFAULTS: ModelSettings = ModelConfig.parse({});

const AgentConfig = z.object({
  max_retries: z.number().default(4),
  auto_apply: z.boolean().default(false),
  auto_test: z.boolean().default(true),
  review_before_apply: z.boolean().default(true),
  small_model_mode: z.boolean().default(true),
  // Edit protocol: "blocks" = SEARCH/REPLACE (reliable for small models),
  // "json" = the legacy JSON-diff coder. Default to blocks.
  edit_protocol: z.enum(["blocks", "json"]).default("blocks"),
  // best-of-N candidate sampling for the block pipeline (1 disables it).
  candidates: z.number().default(2),
  // Run typecheck/lint/test after edits and self-repair from the output.
  verify_after_edit: z.boolean().default(true),
  // Build the symbol index at startup so grounding tools are instant.
  prebuild_symbol_index: z.boolean().default(true),
  // Budget of PRODUCTIVE tool steps per user turn (turns that actually ran a
  // tool). Corrective nudges don't count against this — they're bounded by a
  // separate hard cap (3× this) so the model can't loop forever. Raised from the
  // old fixed 8 because research / multi-file shell work needs more headroom.
  max_tool_steps: z.number().default(16),
  // Adaptive turn budget / "thinking" mode: allow the model to request extra
  // reasoning turns before committing to a tool call or final answer. When
  // enabled, the model can call the `think` tool to spend a "thinking turn"
  // (separate from tool steps) to deliberate. Each thinking turn consumes 1
  // from the thinking budget but does NOT count toward max_tool_steps.
  // The total thinking budget per user turn is max_tool_steps (so a turn with
  // 16 tool steps could have up to 16 thinking turns interleaved).
  thinking_mode: z.boolean().default(true),
  // Maximum thinking turns per user turn (independent of tool steps).
  // Defaults to max_tool_steps so thinking capacity scales with complexity.
  max_thinking_turns: z.number().default(16),
});

const ToolsConfig = z.object({
  allow_shell: z.boolean().default(true),
  confirm_destructive: z.boolean().default(true),
  sandbox: z.boolean().default(true),
  // Regex patterns (case-insensitive). Commands matching allow_commands skip the
  // destructive-confirm prompt (handy for unattended/headless runs of known-safe
  // families like "^git (status|log|diff)" or "^npm (test|run)"). Commands
  // matching deny_commands are hard-blocked. deny wins over allow; neither can
  // override the built-in catastrophic hard-block list.
  allow_commands: z.array(z.string()).default([]),
  deny_commands: z.array(z.string()).default([]),
  // Default wall-clock timeout for a single run_shell command, in ms. Raised from
  // the old fixed 120s so ordinary slow jobs (git clone, npm/pip install, a build)
  // don't get killed. A command can request more via its `timeout_ms` arg (capped
  // at 10 min); genuinely long-running / interactive work should use shell_session.
  shell_timeout_ms: z.number().default(240000),
  // Enable the persistent shell-session tools (shell_session / _read / _reset),
  // backed by a real pseudo-terminal (node-pty). Keeps cwd/env/processes alive
  // across calls and lets long-running commands be polled. Opt-in because a live
  // shell weakens the one-shot isolation of run_shell, and node-pty is a native
  // (optional) dependency — if it isn't installed the tools report so.
  shell_session: z.boolean().default(false),
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

/** Headless LM Studio backend: use its installed models via the lms CLI + /v1 server. */
const LmStudioConfig = z.object({
  enabled: z.boolean().default(true),
  // OpenAI-compatible server. Use the Tailscale IP to reach it across the tailnet.
  base_url: z.string().default("http://localhost:1234"),
  // Bearer token if the server's "Require API Key" is on; empty if disabled.
  api_key: z.string().default(""),
  // Path to lms.exe; empty = auto-detect (~/.lmstudio/bin/lms.exe or PATH).
  cli_path: z.string().default(""),
  start_server: z.boolean().default(true), // ensure the headless server is up at launch
  // Include LM Studio models in the fallback chain (as "lmstudio:<key>").
  include_as_fallback: z.boolean().default(true),
  // Crash-safe loading for big models.
  safe_load: z.boolean().default(true),
  big_params_b: z.number().default(20), // >= this many B params => treat as big
  big_size_gb: z.number().default(14), // >= this on-disk size (GB) => big
  big_context: z.number().default(8192), // capped context for big models
  ttl_seconds: z.number().default(1800), // auto-unload idle big models
});

/** Self-improvement: reflect on mistakes and save lessons to the knowledge vault. */
const EvolutionConfig = z.object({
  enabled: z.boolean().default(true),
  // Only reflect when a turn had failures / hit the step limit (cheap). If false,
  // it could reflect on every turn (more thorough, more tokens).
  reflect_on_failure: z.boolean().default(true),
});

/**
 * NVIDIA NIM cloud endpoint (OpenAI-compatible, https://integrate.api.nvidia.com).
 * Lets a powerful hosted model (e.g. moonshotai/kimi-k2.6) act as the primary
 * brain or a fallback. The API key is a SECRET — never commit it: leave it blank
 * here and set the NVIDIA_API_KEY environment variable, or put it only in your
 * user-level ~/.qwenodyssey/config.toml (which lives outside the repo).
 */
const NvidiaConfig = z.object({
  enabled: z.boolean().default(true),
  base_url: z.string().default("https://integrate.api.nvidia.com"),
  // Prefer leaving blank + using the env var below. If set here, keep it OUT of
  // any committed config file (public repo).
  api_key: z.string().default(""),
  // Environment variable to read the key from when api_key is blank.
  api_key_env: z.string().default("NVIDIA_API_KEY"),
  // Include the nvidia:* refs from fallback_models in the runtime fallback chain.
  include_as_fallback: z.boolean().default(true),
  // For thinking models (kimi, deepseek-v4, r1…) send chat_template_kwargs.thinking=false.
  // On NIM the thinking path degenerates/leaks raw CoT; disabling it gives clean answers.
  disable_thinking: z.boolean().default(true),
  // Abort a NIM request after this many ms so a hung/slow hosted model (e.g.
  // deepseek-v4-pro can stall) fails over to the next model in the chain.
  request_timeout_ms: z.number().default(90000),
  // Nemotron reasoning models use chat_template_kwargs.enable_thinking (a
  // different toggle than kimi/v4's `thinking`) + a reasoning_budget. When true,
  // Qwenodyssey enables their reasoning and caps the thinking tokens below.
  nemotron_thinking: z.boolean().default(true),
  reasoning_budget: z.number().default(4096),
});

/**
 * OpenRouter cloud endpoint (OpenAI-compatible, https://openrouter.ai/api). One
 * key aggregates many providers/models (e.g. moonshotai/kimi-k2.6) that can act
 * as the primary brain or a fallback. The API key is a SECRET — never commit it:
 * leave it blank here and set the OPENROUTER_API_KEY environment variable, or put
 * it only in your user-level ~/.qwenodyssey/config.toml (which lives outside the repo).
 */
const OpenRouterConfig = z.object({
  enabled: z.boolean().default(true),
  base_url: z.string().default("https://openrouter.ai/api"),
  // Prefer leaving blank + using the env var below. If set here, keep it OUT of
  // any committed config file (public repo).
  api_key: z.string().default(""),
  // Environment variable to read the key from when api_key is blank.
  api_key_env: z.string().default("OPENROUTER_API_KEY"),
  // Include the openrouter:* refs from fallback_models in the runtime fallback chain.
  include_as_fallback: z.boolean().default(true),
  // Abort a request after this many ms so a hung/slow hosted model fails over to
  // the next model in the chain.
  request_timeout_ms: z.number().default(90000),
});

/**
 * Anthropic (Claude) cloud endpoint — the NATIVE Messages API
 * (https://api.anthropic.com/v1/messages). Lets a Claude model (Opus/Sonnet/
 * Haiku/Fable) act as the primary brain or a fallback. TWO auth modes:
 *  - **Claude Pro/Max subscription** (OAuth): the agent reads a short-lived bearer
 *    token from the `ant` CLI (`ant auth print-credentials`) when use_cli_auth is
 *    on — the same path Claude Code uses — or from the ANTHROPIC_AUTH_TOKEN env var.
 *  - **API key** (console.anthropic.com, pay-as-you-go): ANTHROPIC_API_KEY.
 * Secrets are NEVER required in a committed file — leave the fields blank and use
 * the env vars or `ant auth login`.
 */
const AnthropicConfig = z.object({
  enabled: z.boolean().default(true),
  base_url: z.string().default("https://api.anthropic.com"),
  // OAuth bearer token for a Claude subscription. Prefer leaving blank + `ant auth login`.
  auth_token: z.string().default(""),
  auth_token_env: z.string().default("ANTHROPIC_AUTH_TOKEN"),
  // Source (and auto-refresh) the OAuth token from the `ant` CLI when no explicit
  // token is set. Turn off if you don't have the Anthropic CLI installed.
  use_cli_auth: z.boolean().default(true),
  // Developer API key (pay-as-you-go). Prefer the env var.
  api_key: z.string().default(""),
  api_key_env: z.string().default("ANTHROPIC_API_KEY"),
  // Include anthropic:* refs from fallback_models in the runtime fallback chain.
  include_as_fallback: z.boolean().default(true),
  // Abort a request after this many ms so a stall fails over to the next model.
  request_timeout_ms: z.number().default(120000),
});

/** Webcam vision: capture a frame and describe it with a vision-language model. */
const VisionConfig = z.object({
  enabled: z.boolean().default(true),
  // Which backend analyzes the captured frame. nvidia/openai use the OpenAI-style
  // image_url payload; ollama uses its native images field.
  provider: z.enum(["nvidia", "openai", "ollama"]).default("nvidia"),
  model: z.string().default("nvidia/nemotron-nano-12b-v2-vl"),
  // DirectShow camera device name; "" = auto-detect the first dshow video device.
  device: z.string().default(""),
  // Ask for confirmation before each capture (the camera is privacy-sensitive).
  confirm: z.boolean().default(true),
});

/** Microphone speech-to-text via a local whisper.cpp binary. */
const AudioConfig = z.object({
  enabled: z.boolean().default(true),
  // DirectShow audio device; "" = auto-detect a mic (prefers one matching the camera).
  device: z.string().default(""),
  // whisper.cpp CLI; "" = auto (whisper-cli / whisper-cpp / main on PATH).
  whisper_bin: z.string().default(""),
  // ggml model path; "" = ~/.qwenodyssey/models/ggml-base.en.bin.
  whisper_model: z.string().default(""),
  // Safety cap on a single push-to-talk recording.
  max_seconds: z.number().default(30),
  language: z.string().default("en"),
  // Voice-activity-detection threshold for continuous listening (whisper-stream).
  // Higher = needs louder/clearer speech to trigger; lower = more sensitive.
  vad_threshold: z.number().default(0.6),
});

/**
 * Omni mode: a single multimodal NIM model does everything — it ingests the mic
 * audio AND the camera frame directly and replies (no separate local STT/vision).
 * Audio + frames are uploaded to the cloud model in this mode.
 */
const OmniConfig = z.object({
  enabled: z.boolean().default(false),
  // Multimodal model that accepts input_audio (+ images) and reasons in one call.
  // nemotron-3-nano-omni (NVIDIA) is verified audio+vision+reasoning and reliable
  // on NIM; microsoft/phi-4-multimodal-instruct also works when not degraded.
  model: z.string().default("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"),
  provider: z.enum(["nvidia", "openai"]).default("nvidia"),
  // Send the camera frame alongside the audio each turn.
  send_image: z.boolean().default(true),
});

/** Spoken replies (text-to-speech). */
const TtsConfig = z.object({
  enabled: z.boolean().default(true),
  // piper = local neural TTS; sapi = built-in Windows voice; none = text only.
  engine: z.enum(["piper", "sapi", "none"]).default("piper"),
  // "" = ~/.qwenodyssey/piper/piper/piper.exe
  piper_bin: z.string().default(""),
  // "" = ~/.qwenodyssey/piper/voices/en_US-amy-medium.onnx
  piper_voice: z.string().default(""),
});

/**
 * Agent swarm: fan a complex task out to MANY frontier models at once, each on
 * its own backend + API key (the cloud refs already in model.fallback_models).
 * "ensemble" = every model answers the same task then a lead synthesizes the
 * best answer; "divide" = independent subtasks are sharded across the models.
 */
const SwarmConfig = z.object({
  enabled: z.boolean().default(true),
  // Hard cap on how many models run concurrently (protects rate limits / cost).
  max_workers: z.number().default(4),
  // Also enlist local refs (bare Ollama tags / lmstudio:*) from the fallback list,
  // not just cloud models. Off by default so the swarm stays frontier-only.
  include_local: z.boolean().default(false),
  // Who merges the workers' answers: "primary" (the active model) or an explicit
  // ref like "openrouter:moonshotai/kimi-k2.6".
  synthesizer: z.string().default("primary"),
  // Per-worker (and synthesis) output token budget.
  max_tokens: z.number().default(1500),
  // COORDINATED mode: a lead model splits the task into dependency-aware subtasks
  // and the agents share a blackboard (each sees its dependencies' results), so the
  // team builds on each other instead of answering blind. On by default for the CLI
  // `swarm` command and the agent_swarm tool; the plain ensemble/divide path is still
  // reachable via --plain / mode:"ensemble".
  coordinate: z.boolean().default(true),
  // Show the live split-pane TUI (one streaming terminal per agent) when the CLI
  // `swarm` command runs in a TTY. Falls back to a plain line log when off / non-TTY.
  live: z.boolean().default(true),
  // Where swarm agents may RUN COMMANDS: "off" = text-only agents (default — safe
  // for cloners); "auto" = bare metal for simple plans, a Daytona sandbox for
  // complex plans (when [daytona] is configured); "bare" / "daytona" = forced.
  exec: z.enum(["off", "auto", "bare", "daytona"]).default("off"),
  // Max run_shell tool steps per agent subtask, and per-command timeout.
  exec_max_steps: z.number().default(5),
  exec_timeout_s: z.number().default(120),
  // Health-check each agent's API key/endpoint before the run (drops broken ones).
  preflight: z.boolean().default(true),
});

/**
 * Daytona (https://daytona.io) — isolated cloud sandboxes where swarm agents run
 * commands for COMPLEX projects (dependency installs, multi-file builds, servers)
 * without touching the host. One sandbox per swarm run, auto-deleted afterwards.
 * Key is a SECRET: leave `api_key` blank and set the env var instead.
 */
const DaytonaConfig = z.object({
  enabled: z.boolean().default(true),
  base_url: z.string().default("https://app.daytona.io/api"),
  api_key: z.string().default(""),
  api_key_env: z.string().default("DAYTONA_API_KEY"),
  // Optional snapshot/image name and target region for new sandboxes.
  snapshot: z.string().default(""),
  target: z.string().default(""),
  // Sandbox lifecycle backstops (minutes): auto-stop when idle, auto-delete after.
  auto_stop_minutes: z.number().default(15),
  auto_delete_minutes: z.number().default(120),
});

/**
 * GitHub access: gives the agent the user's GitHub login so it can read, write,
 * upload and review code. The token is a SECRET — never commit it. Leave `token`
 * blank and the tools fall back to the GITHUB_TOKEN env var, then to the GitHub
 * CLI's own login (`gh auth token`), so an already-`gh auth login`'d machine needs
 * zero config here.
 */
const GithubConfig = z.object({
  enabled: z.boolean().default(true),
  // Personal access token (classic or fine-grained with `repo` scope). Prefer
  // leaving blank + using `gh auth login` or the env var below.
  token: z.string().default(""),
  // Env var to read the token from when `token` is blank.
  token_env: z.string().default("GITHUB_TOKEN"),
  // Default owner for `owner/repo` args; blank = the authenticated user.
  default_owner: z.string().default(""),
  // REST API base (change for GitHub Enterprise).
  api_base: z.string().default("https://api.github.com"),
});

/**
 * Model Context Protocol (MCP) servers. Each entry under [mcp.servers.<name>]
 * launches a stdio MCP server (e.g. `npx -y @modelcontextprotocol/server-filesystem`)
 * and surfaces ITS tools to the agent, namespaced `mcp__<name>__<tool>`. This is
 * how Qwenodyssey plugs into the wider MCP ecosystem (filesystem, git, Slack,
 * Postgres, Puppeteer, …) without bespoke integrations.
 *
 * Example (~/.qwenodyssey/config.toml):
 *   [mcp]
 *   enabled = true
 *   [mcp.servers.filesystem]
 *   command = "npx"
 *   args = ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\evera"]
 *   [mcp.servers.git]
 *   command = "uvx"
 *   args = ["mcp-server-git"]
 */
const McpServerConfig = z.object({
  // Skip this server when false (keep the definition without launching it).
  enabled: z.boolean().default(true),
  // Executable to spawn (npx, uvx, node, python, or an absolute path).
  command: z.string().default(""),
  args: z.array(z.string()).default([]),
  // Extra env vars merged over the process env (e.g. API tokens the server needs).
  env: z.record(z.string()).default({}),
  // Working directory for the server; blank = current dir.
  cwd: z.string().default(""),
});

const McpConfig = z.object({
  // Master switch. Off by default — MCP launches external server processes, so
  // it's opt-in. Turn on and define at least one [mcp.servers.*] to use it.
  enabled: z.boolean().default(false),
  servers: z.record(McpServerConfig).default({}),
  // Timeout for the initialize handshake + tools/list of each server.
  init_timeout_ms: z.number().default(20000),
  // Timeout for a single tools/call.
  call_timeout_ms: z.number().default(60000),
});

/** Internet search + page fetch. */
const WebConfig = z.object({
  enabled: z.boolean().default(true),
  provider: z.enum(["duckduckgo", "tavily", "brave", "searxng"]).default("duckduckgo"),
  api_key: z.string().default(""),
  searxng_url: z.string().default(""),
  max_results: z.number().default(5),
  fetch_chars: z.number().default(8000),
  // Abort a single search/page fetch after this many ms so a hung site can't
  // stall the turn (0 = no timeout).
  fetch_timeout_ms: z.number().default(15000),
});

export const ConfigSchema = z.object({
  model: ModelConfig.default({}),
  agent: AgentConfig.default({}),
  tools: ToolsConfig.default({}),
  memory: MemoryConfig.default({}),
  knowledge: KnowledgeConfig.default({}),
  web: WebConfig.default({}),
  mcp: McpConfig.default({}),
  github: GithubConfig.default({}),
  swarm: SwarmConfig.default({}),
  daytona: DaytonaConfig.default({}),
  evolution: EvolutionConfig.default({}),
  lmstudio: LmStudioConfig.default({}),
  nvidia: NvidiaConfig.default({}),
  openrouter: OpenRouterConfig.default({}),
  anthropic: AnthropicConfig.default({}),
  vision: VisionConfig.default({}),
  audio: AudioConfig.default({}),
  tts: TtsConfig.default({}),
  omni: OmniConfig.default({}),
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

/**
 * User-level config (~/.qwenodyssey/config.toml). Acts as the cross-project base:
 * settings here (e.g. the knowledge vault path, API keys) apply everywhere, while
 * a project's own .qwenodyssey/config.toml overrides them per-repo.
 */
export function globalConfigPath(): string {
  return path.join(os.homedir(), WORKSPACE_DIR, "config.toml");
}

function readTomlRaw(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  try {
    return TOML.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse ${file}: ${(err as Error).message}. ` +
        `Run "qwenodyssey init --force" to regenerate it.`
    );
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep-merge `source` over `base`: nested tables merge, arrays/scalars replace. */
function deepMerge(
  base: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(source)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/**
 * Load configuration, layering the project's .qwenodyssey/config.toml ON TOP of
 * the user-level ~/.qwenodyssey/config.toml. The global file holds machine-wide
 * defaults (knowledge vault, keys, backend); the project file overrides only what
 * it sets. With neither present, built-in defaults are used.
 */
export function loadConfig(cwd: string): Config {
  const projectFile = configPath(cwd);
  const globalFile = globalConfigPath();
  const sameFile = path.resolve(projectFile) === path.resolve(globalFile);

  const globalRaw = readTomlRaw(globalFile);
  // Avoid reading the same file twice when cwd IS the home directory.
  const projectRaw = sameFile ? null : readTomlRaw(projectFile);

  if (!globalRaw && !projectRaw) return defaultConfig();

  const merged = deepMerge(globalRaw ?? {}, projectRaw ?? {});
  try {
    return ConfigSchema.parse(merged);
  } catch (err) {
    throw new Error(
      `Invalid configuration (merged ${globalFile} + ${projectFile}): ` +
        `${(err as Error).message}. Run "qwenodyssey init --force" to regenerate the project config.`
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
