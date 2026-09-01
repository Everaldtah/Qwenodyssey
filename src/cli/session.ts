/**
 * Build the shared runtime objects a command needs from global CLI flags.
 */
import * as path from "path";
import type { AgentMode, ToolContext } from "../types";
import { loadConfig, Config } from "../core/config";
import { Logger } from "../core/logger";
import { ToolRegistry } from "../tools/registry";
import { createProvider } from "../providers";
import { LmStudioControl } from "../providers/lmstudioControl";
import type { LmsModel } from "../providers/lmstudioControl";
import { MemoryStore } from "../agents/memory";

export interface GlobalOpts {
  cwd?: string;
  verbose?: boolean;
  yes?: boolean;
  mode?: AgentMode;
  /** chat: resume the most recent session in this directory. */
  continue?: boolean;
  /** chat: resume a saved session by id, or `true` to pick one from a list. */
  resume?: string | boolean;
}

export interface Session {
  cwd: string;
  config: Config;
  logger: Logger;
  tools: ToolRegistry;
  memory: MemoryStore;
  provider: ReturnType<typeof createProvider>;
  autoConfirm: boolean;
  mode: AgentMode;
  /** Qwenodyssey's own source/install root (this package), for self-inspection/modification. */
  selfRoot: string;
  /** Headless LM Studio control (lms CLI). */
  lms: LmStudioControl;
  /** Cached LM Studio model keys (populated at chat startup), for fallback. */
  lmsModelKeys: string[];
  /** Full LM Studio inventory from the same startup `lms ls` (saves re-running it). */
  lmsModels?: LmsModel[];
  /** Resolves once the startup LM Studio inventory is in (never rejects). */
  lmsReady?: Promise<void>;
  /**
   * Rebuild the dynamic SELF-AWARENESS block in the chat system prompt so it
   * matches the currently active provider/model. Installed by the chat command
   * and invoked whenever the active model changes (model switch or fallback),
   * so a model never reports a stale identity (e.g. a switched-to Ollama model
   * claiming to still be the configured cloud primary).
   */
  refreshIdentity?: () => void;
  /**
   * Set once the user picks a model by hand (/model, /models). Background
   * startup resolution must then leave the choice alone — previously a slow
   * startup could finish AFTER a manual switch and silently move the session
   * to the first cloud fallback.
   */
  modelPinned?: boolean;
  /** Absolute paths the model has read (or written) this session — see the write_file guard. */
  seenFiles?: Set<string>;
}

/** This package's root: dist/cli/session.js → ../.. ; src/cli/session.ts → ../.. */
export const SELF_ROOT = path.resolve(__dirname, "..", "..");

export function createSession(opts: GlobalOpts): Session {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const config = loadConfig(cwd);
  const logger = new Logger(cwd, { verbose: opts.verbose });
  const autoConfirm = !!opts.yes;

  const toolCtx: ToolContext = {
    cwd,
    autoConfirm,
    confirmDestructive: config.tools.confirm_destructive,
    allowShell: config.tools.allow_shell,
    sandbox: config.tools.sandbox,
    selfRoot: SELF_ROOT,
    log: (entry) => logger.event(entry),
  };

  const tools = new ToolRegistry(toolCtx);
  const memory = new MemoryStore(path.resolve(cwd, config.memory.path));
  const provider = createProvider(config);

  return {
    cwd,
    config,
    logger,
    tools,
    memory,
    provider,
    autoConfirm,
    mode: opts.mode || (config.agent.small_model_mode ? "safe" : "deep"),
    selfRoot: SELF_ROOT,
    lms: new LmStudioControl(config.lmstudio.cli_path || undefined),
    lmsModelKeys: [],
  };
}
