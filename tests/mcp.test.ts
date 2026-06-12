import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createMcpTools } from "../src/tools/mcpTools";
import { mcpToolName } from "../src/tools/mcpTools";
import { defaultConfig } from "../src/core/config";

// A tiny in-repo MCP stdio server (echo + add) so the test needs no network.
const MOCK_SERVER = `
let buf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize")
      reply(msg.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0" } });
    else if (msg.method === "tools/list")
      reply(msg.id, { tools: [
        { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
        { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
      ] });
    else if (msg.method === "tools/call") {
      const { name, arguments: a } = msg.params;
      if (name === "echo") reply(msg.id, { content: [{ type: "text", text: "echoed: " + a.text }] });
      else if (name === "add") reply(msg.id, { content: [{ type: "text", text: String((a.a || 0) + (a.b || 0)) }] });
      else reply(msg.id, { content: [{ type: "text", text: "unknown" }], isError: true });
    }
  }
});
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
`;

const serverPath = path.join(os.tmpdir(), `qo-mock-mcp-${process.pid}.js`);
fs.writeFileSync(serverPath, MOCK_SERVER, "utf-8");
afterAll(() => {
  try { fs.unlinkSync(serverPath); } catch { /* ignore */ }
});

const OPTS = { initTimeoutMs: 8000, callTimeoutMs: 8000 };

describe("mcpToolName", () => {
  it("namespaces and sanitizes to a function-call-safe name", () => {
    expect(mcpToolName("filesystem", "read_file")).toBe("mcp__filesystem__read_file");
    expect(mcpToolName("my server", "do-it!")).toBe("mcp__my_server__do_it_");
  });
});

describe("createMcpTools (stdio)", () => {
  it("connects, discovers tools, and invokes them", async () => {
    const setup = await createMcpTools([{ name: "mock", command: "node", args: [serverPath] }], OPTS);
    try {
      expect(setup.infos).toEqual(["MCP mock: 2 tools"]);
      expect(setup.specs.map((s) => s.name)).toEqual(["mcp__mock__echo", "mcp__mock__add"]);
      // The server's inputSchema is advertised verbatim as the tool parameters.
      expect(setup.specs[0].parameters).toMatchObject({ properties: { text: { type: "string" } } });

      const ctx: any = { log: () => {} };
      const echo = setup.tools.find((t) => t.name === "mcp__mock__echo")!;
      const add = setup.tools.find((t) => t.name === "mcp__mock__add")!;
      expect(await echo.run({ text: "hi" }, ctx)).toEqual({ ok: true, output: "echoed: hi" });
      expect(await add.run({ a: 2, b: 40 }, ctx)).toEqual({ ok: true, output: "42" });
    } finally {
      setup.clients.forEach((c) => c.dispose());
    }
  });

  it("degrades gracefully when a server fails to start", async () => {
    const setup = await createMcpTools(
      [{ name: "broken", command: "qo_no_such_binary_xyz", args: [] }],
      { initTimeoutMs: 4000, callTimeoutMs: 4000 }
    );
    expect(setup.tools).toHaveLength(0);
    expect(setup.specs).toHaveLength(0);
    expect(setup.infos[0]).toMatch(/^MCP broken: failed/);
    setup.clients.forEach((c) => c.dispose());
  });
});

describe("mcp config", () => {
  it("defaults to disabled with no servers", () => {
    const cfg = defaultConfig();
    expect(cfg.mcp.enabled).toBe(false);
    expect(cfg.mcp.servers).toEqual({});
    expect(cfg.mcp.call_timeout_ms).toBeGreaterThan(0);
  });
});
