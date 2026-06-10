import { describe, it, expect } from "vitest";
import { createWebTools, condense, WebConfig } from "../src/tools/webTools";
import type { ToolContext } from "../src/types";

const ctx: ToolContext = { cwd: ".", autoConfirm: true, confirmDestructive: false, allowShell: true, sandbox: true, log: () => {} };
const cfg: WebConfig = { provider: "duckduckgo", apiKey: "", searxngUrl: "", maxResults: 5, fetchChars: 4000, fetchTimeoutMs: 5000 };

const tools = createWebTools(cfg);
const tool = (name: string) => tools.find((t) => t.name === name)!;

describe("web tools wiring", () => {
  it("exposes web_search, web_fetch, web_research, deep_research", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(["deep_research", "web_fetch", "web_research", "web_search"]);
  });
});

describe("SSRF guard (web_fetch)", () => {
  it("refuses loopback hosts", async () => {
    const r = await tool("web_fetch").run({ url: "http://localhost:8080/admin" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/private|loopback|SSRF/i);
  });
  it("refuses private IPv4 ranges", async () => {
    for (const u of ["http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://169.254.1.1/"]) {
      const r = await tool("web_fetch").run({ url: u }, ctx);
      expect(r.ok).toBe(false);
    }
  });
  it("refuses non-http(s) schemes", async () => {
    const r = await tool("web_fetch").run({ url: "file:///etc/passwd" }, ctx);
    expect(r.ok).toBe(false);
  });
});

describe("condense (extractive, query-focused)", () => {
  it("prefers sentences containing the query terms", () => {
    const text =
      "The weather today is mild and pleasant across the region. " +
      "The new graphics card delivers a massive performance uplift for gaming. " +
      "Local traffic was lighter than usual this morning.";
    const out = condense(text, "graphics card performance", 200);
    expect(out).toMatch(/graphics card/);
  });
  it("falls back to leading sentences with no query terms", () => {
    const text = "First sentence is reasonably long and informative here. Second sentence follows along too.";
    const out = condense(text, "", 200);
    expect(out).toMatch(/First sentence/);
  });
});
