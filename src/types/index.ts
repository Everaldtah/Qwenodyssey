/**
 * Shared types for Qwenodyssey.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
}

export interface ModelOptions {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  /** Hint that the response should be valid JSON. */
  json?: boolean;
}

export interface GenerateResult {
  text: string;
  /** Best-effort token accounting; may be approximate for some providers. */
  promptTokens?: number;
  completionTokens?: number;
  model: string;
}

/**
 * Uniform interface every model backend implements.
 */
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
