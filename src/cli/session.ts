/**
 * Build the shared runtime objects a command needs from global CLI flags.
 */
import * as path from "path";
import type { AgentMode, ToolContext } from "../types";
import { loadConfig, Config } from "../core/config";
import { Logger } from "../core/logger";
import { ToolRegistry } from "../tools/registry";
import { createProvider } from "../providers";
import { MemoryStore } from "../agents/memory";

export interface GlobalOpts {
  cwd?: string;
  verbose?: boolean;
  yes?: boolean;
  mode?: AgentMode;
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
}

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
  };
}
