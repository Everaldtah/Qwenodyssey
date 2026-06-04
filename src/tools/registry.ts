/**
 * Tool registry: central catalog the agents call into.
 */
import type { Tool, ToolContext, ToolResult } from "../types";
import {
  readFileTool,
  writeFileTool,
  createFileTool,
  deleteFileTool,
  listFilesTool,
  treeTool,
} from "./fileTools";
import { runShellTool } from "./shellTools";
import { shellHelpTool } from "./shellEncyclopedia";
import { gitStatusTool, gitDiffTool } from "./gitTools";
import { grepTool, searchDocsTool } from "./searchTools";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(private ctx: ToolContext) {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    [
      readFileTool,
      writeFileTool,
      createFileTool,
      deleteFileTool,
      listFilesTool,
      treeTool,
      runShellTool,
      shellHelpTool,
      gitStatusTool,
      gitDiffTool,
      grepTool,
      searchDocsTool,
    ].forEach((t) => this.register(t));
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  async run(name: string, args: Record<string, any>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, output: `Unknown tool: ${name}` };
    try {
      return await tool.run(args, this.ctx);
    } catch (err) {
      this.ctx.log({ tool: name, error: (err as Error).message });
      return { ok: false, output: `Tool "${name}" error: ${(err as Error).message}` };
    }
  }
}
