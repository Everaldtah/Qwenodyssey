import { describe, it, expect } from "vitest";
import { resolveToolName, prepareToolCall } from "../src/tools/toolCallPrep";
import { extractJson, extractAllJson } from "../src/core/parse";
import { compactToolSpecs } from "../src/cli/chatTools";
import { createThinkTool, THINK_TOOL_SPEC } from "../src/tools/thinkTool";
import type { ToolSpec } from "../src/types";

const SPECS: ToolSpec[] = [
  {
    name: "run_shell",
    description: "run a command",
    parameters: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "integer" } }, required: ["command"] },
  },
  {
    name: "read_file",
    description: "read a file",
    parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" } }, required: ["path"] },
  },
  {
    name: "apply_edit",
    description: "search/replace edit",
    parameters: { type: "object", properties: { path: { type: "string" }, search: { type: "string" }, replace: { type: "string" } }, required: ["path", "replace"] },
  },
  {
    name: "web_search",
    description: "search the web",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];
const NAMES = SPECS.map((s) => s.name);

describe("toolCallPrep — hallucinated-name alias table", () => {
  it("maps cross-harness shell aliases onto run_shell", () => {
    for (const alias of ["bash", "shell", "execute_command", "terminal", "cmd"]) {
      expect(resolveToolName(alias, NAMES).name).toBe("run_shell");
    }
  });
  it("maps unix-ish file aliases", () => {
    expect(resolveToolName("cat", NAMES).name).toBe("read_file");
    expect(resolveToolName("str_replace_editor", NAMES).name).toBe("apply_edit");
    expect(resolveToolName("google", NAMES).name).toBe("web_search");
  });
  it("strips hallucinated namespace prefixes", () => {
    expect(resolveToolName("functions.run_shell", NAMES).name).toBe("run_shell");
    expect(resolveToolName("default_api.read_file", NAMES).name).toBe("read_file");
    expect(resolveToolName("tools.bash", NAMES).name).toBe("run_shell");
  });
  it("does not alias to a tool that is not advertised", () => {
    const r = resolveToolName("bash", ["read_file", "web_search"]);
    expect(r.name).toBeUndefined();
  });
});

describe("toolCallPrep — argument-key aliasing", () => {
  it("maps `file` → `path` for read_file", () => {
    const p = prepareToolCall("read_file", { file: "a.ts" } as any, SPECS);
    expect(p.error).toBeUndefined();
    expect(p.arguments.path).toBe("a.ts");
    expect(p.note).toMatch(/mapped argument/);
  });
  it("maps `cmd` → `command` for run_shell", () => {
    const p = prepareToolCall("run_shell", { cmd: "git status" } as any, SPECS);
    expect(p.error).toBeUndefined();
    expect(p.arguments.command).toBe("git status");
  });
  it("maps Claude-style old_str/new_str onto search/replace", () => {
    const p = prepareToolCall("str_replace_editor", { path: "a.ts", old_str: "x", new_str: "y" } as any, SPECS);
    expect(p.name).toBe("apply_edit");
    expect(p.arguments.search).toBe("x");
    expect(p.arguments.replace).toBe("y");
  });
  it("never steals a key that is a real property of the tool", () => {
    // `search` is a real apply_edit property — must not be re-mapped away.
    const p = prepareToolCall("apply_edit", { path: "a.ts", search: "x", replace: "y" }, SPECS);
    expect(p.arguments.search).toBe("x");
  });
  it("drops undeclared extra keys the model invented", () => {
    const p = prepareToolCall("read_file", { path: "a.ts", recursive: true } as any, SPECS);
    expect("recursive" in p.arguments).toBe(false);
  });
  it("alias fills a missing REQUIRED field instead of erroring", () => {
    const p = prepareToolCall("run_shell", { script: "ls" } as any, SPECS);
    expect(p.error).toBeUndefined();
    expect(p.arguments.command).toBe("ls");
  });
});

describe("parse — repairJson escalation", () => {
  it("extractJson recovers single-quoted JSON", () => {
    expect(extractJson(`{'name': 'run_shell', 'arguments': {'command': 'ls'}}`)).toEqual({
      name: "run_shell",
      arguments: { command: "ls" },
    });
  });
  it("extractJson recovers bare keys + Python literals", () => {
    expect(extractJson(`{name: "x", ok: True, missing: None}`)).toEqual({ name: "x", ok: true, missing: null });
  });
  it("extractAllJson repairs a malformed inline tool call among valid ones", () => {
    const text = `First {"name":"read_file","arguments":{"path":"a.ts"}} then {'name': 'run_shell', 'arguments': {'command': 'ls'}}`;
    const all = extractAllJson(text);
    expect(all.length).toBe(2);
    expect(all[1]).toEqual({ name: "run_shell", arguments: { command: "ls" } });
  });
});

describe("think tool (thinking mode)", () => {
  const specs = [...SPECS, THINK_TOOL_SPEC];
  const names = specs.map((s) => s.name);
  const ctx = { log: () => {} } as any;

  it("resolves hallucinated deliberation names onto think when advertised", () => {
    for (const alias of ["thought", "reflect", "reason", "internal_monologue"]) {
      expect(resolveToolName(alias, names).name).toBe("think");
    }
    // ...but not when the tool isn't advertised (thinking_mode off).
    expect(resolveToolName("internal_monologue", NAMES).name).toBeUndefined();
  });
  it("maps `reasoning` → `thought` argument", () => {
    const p = prepareToolCall("think", { reasoning: "check the exit code first" } as any, specs);
    expect(p.error).toBeUndefined();
    expect(p.arguments.thought).toBe("check the exit code first");
  });
  it("records a thought and tells the model to act next", async () => {
    const r = await createThinkTool().run({ thought: "the test failed because of X" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/next step/i);
  });
  it("rejects an empty thought", async () => {
    const r = await createThinkTool().run({ thought: "  " }, ctx);
    expect(r.ok).toBe(false);
  });
});

describe("compactToolSpecs", () => {
  const verbose: ToolSpec[] = [
    {
      name: "run_shell",
      description:
        "Execute ONE shell command in the project directory and return its combined stdout/stderr. " +
        "Use this for any real action: checking the OS, network/wifi status, running tests, git, " +
        "listing processes, installing packages, etc. On Windows the shell is PowerShell. Each call " +
        "is a FRESH shell (cwd/env do NOT persist between calls). It blocks until the command finishes " +
        "or times out. For slow commands pass a larger timeout_ms. Never loop downloading files.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The exact command line to run." },
          timeout_ms: {
            type: "integer",
            description:
              "Max wall-clock time before abort (default ~240000, max 600000). Raise it for slow commands like builds or installs.",
          },
        },
        required: ["command"],
      },
    },
  ];

  it("shortens descriptions but preserves names/types/required", () => {
    const c = compactToolSpecs(verbose);
    expect(c[0].name).toBe("run_shell");
    expect(c[0].description.length).toBeLessThanOrEqual(181);
    expect(c[0].description).toMatch(/^Execute ONE shell command/);
    expect(c[0].parameters.required).toEqual(["command"]);
    expect(c[0].parameters.properties.command.type).toBe("string");
    expect(c[0].parameters.properties.timeout_ms.type).toBe("integer");
  });
  it("cuts at a sentence boundary when possible", () => {
    const c = compactToolSpecs(verbose);
    expect(c[0].description.endsWith(".") || c[0].description.endsWith("…")).toBe(true);
  });
  it("does not mutate the originals", () => {
    const before = verbose[0].description;
    compactToolSpecs(verbose);
    expect(verbose[0].description).toBe(before);
  });
});
