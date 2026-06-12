/**
 * Minimal Model Context Protocol (MCP) client over the stdio transport.
 *
 * MCP servers speak JSON-RPC 2.0 as newline-delimited JSON on stdin/stdout. We
 * spawn the server, do the initialize handshake, then expose tools/list and
 * tools/call. Deliberately dependency-free (no @modelcontextprotocol/sdk) to keep
 * Qwenodyssey's footprint small and its "no copied source" policy clean — this is
 * a clean-room implementation of the wire protocol, which is an open spec.
 *
 * Supports stdio servers (the common case: `npx -y @modelcontextprotocol/...`).
 * HTTP/SSE transports are out of scope for this first cut.
 */
import { spawn, ChildProcess } from "child_process";

/** The protocol revision we advertise; the server echoes whatever it supports. */
const PROTOCOL_VERSION = "2025-06-18";

export interface McpServerSpec {
  /** Stable short name, used to namespace the server's tools (e.g. "filesystem"). */
  name: string;
  /** Executable to launch (e.g. "npx", "uvx", "node", an absolute path). */
  command: string;
  args?: string[];
  /** Extra environment variables merged over the parent process env. */
  env?: Record<string, string>;
  /** Working directory for the server process. */
  cwd?: string;
}

export interface McpToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments (MCP calls this `inputSchema`). */
  inputSchema?: Record<string, any>;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  private proc?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private stderr = "";
  private closed = false;
  /** Resolved once the initialize handshake completes. */
  initialized = false;

  constructor(
    private spec: McpServerSpec,
    private opts: { initTimeoutMs: number; callTimeoutMs: number }
  ) {}

  get name(): string {
    return this.spec.name;
  }

  /** Spawn the server and complete the MCP initialize handshake. */
  async start(): Promise<void> {
    this.proc = spawn(this.spec.command, this.spec.args ?? [], {
      cwd: this.spec.cwd || process.cwd(),
      env: { ...process.env, ...(this.spec.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      // .cmd/.bat (npx, uvx on Windows) require a shell since Node 20.
      shell: process.platform === "win32",
    });

    this.proc.on("error", (err) => this.failAll(new Error(`spawn failed: ${err.message}`)));
    this.proc.on("exit", (code) => {
      if (!this.closed) this.failAll(new Error(`server exited (code ${code})${this.stderr ? `: ${this.tailStderr()}` : ""}`));
    });
    this.proc.stdout?.setEncoding("utf-8");
    this.proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr?.setEncoding("utf-8");
    this.proc.stderr?.on("data", (chunk: string) => {
      this.stderr += chunk;
      if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000);
    });

    const res = await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "qwenodyssey", version: "0.3.0" },
      },
      this.opts.initTimeoutMs
    );
    void res;
    // Per spec, follow up with the initialized notification before any other call.
    this.notify("notifications/initialized");
    this.initialized = true;
  }

  /** Discover the tools this server exposes. */
  async listTools(): Promise<McpToolDef[]> {
    const res = await this.request("tools/list", {}, this.opts.initTimeoutMs);
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    return tools.map((t: any) => ({
      name: String(t.name),
      description: t.description ? String(t.description) : "",
      inputSchema: isObject(t.inputSchema) ? t.inputSchema : { type: "object", properties: {} },
    }));
  }

  /** Invoke a tool; returns its content flattened to a single text string. */
  async callTool(name: string, args: Record<string, any>): Promise<{ text: string; isError: boolean }> {
    const res = await this.request("tools/call", { name, arguments: args ?? {} }, this.opts.callTimeoutMs);
    const parts = Array.isArray(res?.content) ? res.content : [];
    const text = parts
      .map((p: any) => {
        if (p?.type === "text") return String(p.text ?? "");
        if (p?.type === "resource" && p.resource) return String(p.resource.text ?? p.resource.uri ?? "");
        if (p?.type === "image") return "[image content omitted]";
        return typeof p === "string" ? p : JSON.stringify(p);
      })
      .join("\n")
      .trim();
    return { text: text || "(no output)", isError: !!res?.isError };
  }

  /** Terminate the server process and reject any in-flight calls. */
  dispose(): void {
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("client disposed"));
    }
    this.pending.clear();
    try {
      this.proc?.kill();
    } catch {
      /* already gone */
    }
  }

  // ── JSON-RPC plumbing ──────────────────────────────────────────────────────

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.closed) return Promise.reject(new Error("client closed"));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`"${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc?.stdin?.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`write failed: ${err.message}`));
        }
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n";
    this.proc?.stdin?.write(payload);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    // Newline-delimited JSON: process every complete line, keep the remainder.
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON noise (some servers log to stdout)
      }
      if (msg.id == null) continue; // a notification/log from the server — ignore
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || `JSON-RPC error ${msg.error.code}`));
      else p.resolve(msg.result);
    }
  }

  private failAll(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  private tailStderr(): string {
    return this.stderr.split("\n").filter(Boolean).slice(-3).join(" | ");
  }
}

function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
