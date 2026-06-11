/**
 * Shared types for Qwenodyssey.
 */

export type Role = "system" | "user" | "assistant" | "tool";

/** A model's request to invoke a tool (OpenAI-style function call). */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface Message {
  role: Role;
  content: string;
  /** Present on assistant messages that requested tool calls. */
  tool_calls?: ToolCall[];
  /** Present on tool-result messages: which call this answers. */
  tool_call_id?: string;
  /** Tool name, for tool-result messages. */
  name?: string;
}

/** OpenAI-style tool/function schema advertised to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface ModelOptions {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  /** Hint that the response should be valid JSON. */
  json?: boolean;
  /** Tools the model may call this turn. */
  tools?: ToolSpec[];
  /** Ask the model to expose its chain-of-thought (reasoning models via Ollama). */
  think?: boolean;
  /** Abort the request mid-flight (Esc interrupt). Stops streaming immediately. */
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  /** Tool calls the model requested, if any. */
  toolCalls?: ToolCall[];
  /** Separate chain-of-thought, when the backend returns it (Ollama `thinking`). */
  thinking?: string;
  /** Best-effort token accounting; may be approximate for some providers. */
  promptTokens?: number;
  completionTokens?: number;
  model: string;
}

/**
 * Uniform interface every model backend implements.
 */
export interface ModelInfo {
  name: string;
  /** Human-readable size, e.g. "4.7 GB", when the backend reports it. */
  size?: string;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  generate(messages: Message[], options?: ModelOptions): Promise<GenerateResult>;
  stream(
    messages: Message[],
    onChunk: (delta: string) => void,
    options?: ModelOptions
  ): Promise<GenerateResult>;
  countTokens(text: string): number;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
  /** List models the backend currently has available, if it can. */
  listModels?(): Promise<ModelInfo[]>;
  /** Switch the active model for the rest of the session. */
  setModel?(model: string): void;
}

/* ── Agent pipeline ── */

export interface PlanStep {
  index: number;
  title: string;
  detail?: string;
  files?: string[];
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  files: string[];
  assumptions?: string[];
}

export type EditMode = "patch" | "create" | "rewrite" | "delete";

export interface FileEdit {
  path: string;
  mode: EditMode;
  /** Unified diff (for mode === "patch"). */
  diff?: string;
  /** Full file contents (for "create"/"rewrite"). */
  content?: string;
  rationale?: string;
}

export interface CoderResult {
  edits: FileEdit[];
  notes?: string;
}

export interface ReviewIssue {
  severity: "info" | "warning" | "error";
  file?: string;
  message: string;
}

export interface ReviewResult {
  approve: boolean;
  issues: ReviewIssue[];
  summary?: string;
}

export interface TestResult {
  ran: boolean;
  passed: boolean;
  command?: string;
  output: string;
}

/* ── Repo scanning ── */

export interface RepoInfo {
  root: string;
  languages: string[];
  framework?: string;
  packageManager?: string;
  testCommand?: string;
  lintCommand?: string;
  buildCommand?: string;
  entrypoints: string[];
  keyFiles: string[];
  fileCount: number;
  hasGit: boolean;
  dirty: boolean;
}

/* ── Tools ── */

export interface ToolContext {
  cwd: string;
  /** Skip confirmation prompts when true (e.g. --yes). */
  autoConfirm: boolean;
  confirmDestructive: boolean;
  allowShell: boolean;
  sandbox: boolean;
  /** Config tools.allow_commands — auto-approved (skip the destructive gate). */
  allowCommands?: string[];
  /** Config tools.deny_commands — hard-blocked. */
  denyCommands?: string[];
  /** Default run_shell timeout in ms (config tools.shell_timeout_ms). */
  shellTimeoutMs?: number;
  /** Qwenodyssey's own install/source root — writable so the agent can self-modify. */
  selfRoot?: string;
  log: (entry: Record<string, unknown>) => void;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  data?: unknown;
}

export interface Tool {
  name: string;
  description: string;
  /** Whether the tool can modify the filesystem / run commands. */
  mutating: boolean;
  run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult>;
}

/* ── Modes ── */

export type AgentMode = "fast" | "safe" | "deep" | "pair" | "autofix";
