/**
 * Bridges MCP servers into Qwenodyssey's tool system: connect to each configured
 * server, discover its tools, and expose them as native harness Tools + ToolSpecs
 * the model can call like any other (run_shell, web_search, …).
 *
 * Tool names are namespaced `mcp__<server>__<tool>` so two servers can both have a
 * "search" tool without colliding, and so the model can tell at a glance a call
 * goes out to an MCP server.
 */
import type { Tool, ToolSpec } from "../types";
import { McpClient, McpServerSpec } from "./mcpClient";

export interface McpSetup {
  /** Handlers to register on the chat ToolRegistry. */
  tools: Tool[];
  /** Schemas to advertise to the model. */
  specs: ToolSpec[];
  /** Live clients — dispose these when the chat exits. */
  clients: McpClient[];
  /** One human-readable status line per server (connected or failed). */
  infos: string[];
}

/** MCP tool names must be function-call-safe; sanitize and namespace them. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");
  return `mcp__${clean(server)}__${clean(tool)}`;
}

/**
 * Connect to every server in `specs`, in parallel, and build the tool set. A
 * server that fails to start or list tools is skipped with a status line — it
 * never blocks the others or crashes chat startup.
 */
export async function createMcpTools(
  specs: McpServerSpec[],
  opts: { initTimeoutMs: number; callTimeoutMs: number }
): Promise<McpSetup> {
  const tools: Tool[] = [];
  const toolSpecs: ToolSpec[] = [];
  const clients: McpClient[] = [];
  const infos: string[] = [];

  await Promise.all(
    specs.map(async (spec) => {
      const client = new McpClient(spec, opts);
      try {
        await client.start();
        const defs = await client.listTools();
        if (defs.length === 0) {
          infos.push(`MCP ${spec.name}: connected, but exposes no tools`);
          client.dispose();
          return;
        }
        clients.push(client);
        for (const def of defs) {
          const fqName = mcpToolName(spec.name, def.name);
          const description =
            `[MCP:${spec.name}] ${def.description || def.name}`.slice(0, 1024);
          toolSpecs.push({
            name: fqName,
            description,
            parameters: def.inputSchema ?? { type: "object", properties: {} },
          });
          tools.push({
            name: fqName,
            description,
            // External, possibly side-effectful — run serially, never auto-batched.
            mutating: true,
            async run(args, ctx) {
              try {
                const r = await client.callTool(def.name, args ?? {});
                ctx.log({ tool: fqName, isError: r.isError });
                return { ok: !r.isError, output: r.text };
              } catch (err) {
                return { ok: false, output: `MCP ${spec.name}/${def.name} failed: ${(err as Error).message}` };
              }
            },
          });
        }
        infos.push(`MCP ${spec.name}: ${defs.length} tool${defs.length === 1 ? "" : "s"}`);
      } catch (err) {
        infos.push(`MCP ${spec.name}: failed — ${(err as Error).message}`);
        client.dispose();
      }
    })
  );

  return { tools, specs: toolSpecs, clients, infos };
}
