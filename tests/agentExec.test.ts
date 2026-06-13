import { describe, it, expect } from "vitest";
import { defaultConfig } from "../src/core/config";
import {
  BareExecutor,
  DaytonaExecutor,
  chooseExecutor,
  daytonaAvailable,
} from "../src/core/agentExec";
import { CoordinatedSwarm, parseComplexity } from "../src/core/swarmCoordinator";
import type { Message, Provider } from "../src/types";
import type { SwarmWorker } from "../src/core/swarm";

describe("parseComplexity", () => {
  it("reads the planner's judgment and defaults to simple", () => {
    expect(parseComplexity('{"complexity":"complex","subtasks":[]}')).toBe("complex");
    expect(parseComplexity('{"complexity":"simple","subtasks":[]}')).toBe("simple");
    expect(parseComplexity('{"subtasks":[]}')).toBe("simple");
  });
});

describe("chooseExecutor routing", () => {
  it("off → none; bare → bare; auto+simple → bare", () => {
    const cfg = defaultConfig();
    expect(chooseExecutor(cfg, "off", "complex").executor).toBeNull();
    expect(chooseExecutor(cfg, "bare", "complex").executor?.kind).toBe("bare");
    expect(chooseExecutor(cfg, "auto", "simple").executor?.kind).toBe("bare");
  });

  it("auto+complex → daytona when a key exists, bare with a note when not", () => {
    const cfg = defaultConfig();
    delete process.env.DAYTONA_API_KEY;
    expect(daytonaAvailable(cfg)).toBe(false);
    const noKey = chooseExecutor(cfg, "auto", "complex");
    expect(noKey.executor?.kind).toBe("bare");
    expect(noKey.note).toContain("daytona not configured");

    cfg.daytona.api_key = "dtn_test";
    expect(daytonaAvailable(cfg)).toBe(true);
    expect(chooseExecutor(cfg, "auto", "complex").executor?.kind).toBe("daytona");
    // forced daytona honors the key too
    expect(chooseExecutor(cfg, "daytona", "simple").executor?.kind).toBe("daytona");
  });
});

describe("BareExecutor", () => {
  it("refuses hard-blocked and destructive commands without running them", async () => {
    const ex = new BareExecutor();
    const blocked = await ex.run("Format-Volume -DriveLetter C");
    expect(blocked.ok).toBe(false);
    expect(blocked.output).toContain("hard-blocked");

    const destructive = await ex.run("Remove-Item -Recurse some/dir");
    expect(destructive.ok).toBe(false);
    expect(destructive.output).toContain("destructive");
  });

  it("runs a safe command and captures output + exit code", async () => {
    const ex = new BareExecutor();
    const r = await ex.run('node -e "console.log(40+2)"', { timeoutMs: 30000 });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("42");
  }, 40000);
});

describe("DaytonaExecutor (mocked REST)", () => {
  function mockFetch(log: string[]): typeof fetch {
    return (async (url: any, init?: any) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      log.push(`${method} ${u}`);
      const json = (obj: unknown) =>
        new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
      if (method === "POST" && u.endsWith("/sandbox")) return json({ id: "sb-1", state: "creating" });
      if (method === "GET" && u.endsWith("/sandbox/sb-1")) return json({ id: "sb-1", state: "started" });
      if (method === "POST" && u.includes("/toolbox/sb-1/toolbox/process/execute")) {
        const body = JSON.parse(init.body);
        return json({ exitCode: 0, result: `ran: ${body.command}` });
      }
      if (method === "DELETE" && u.endsWith("/sandbox/sb-1")) return json({});
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  it("creates one sandbox, executes commands in it, and deletes it on dispose", async () => {
    const cfg = defaultConfig();
    cfg.daytona.api_key = "dtn_test";
    const log: string[] = [];
    const ex = new DaytonaExecutor(cfg, mockFetch(log));

    const r1 = await ex.run("echo one");
    const r2 = await ex.run("echo two");
    expect(r1.ok).toBe(true);
    expect(r1.output).toBe("ran: echo one");
    expect(r2.output).toBe("ran: echo two");
    // exactly ONE sandbox creation despite two commands
    expect(log.filter((l) => l.startsWith("POST") && l.endsWith("/sandbox"))).toHaveLength(1);

    await ex.dispose();
    expect(log.some((l) => l.startsWith("DELETE") && l.endsWith("/sandbox/sb-1"))).toBe(true);
    const after = await ex.run("echo three");
    expect(after.ok).toBe(false);
    expect(after.output).toContain("disposed");
  });

  it("surfaces HTTP errors as failed results, not throws", async () => {
    const cfg = defaultConfig();
    cfg.daytona.api_key = "dtn_test";
    const bad = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const ex = new DaytonaExecutor(cfg, bad);
    const r = await ex.run("echo hi");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("HTTP 401");
  });
});

describe("agent tool loop (executor wired into the swarm)", () => {
  function fakeExec(log: string[]) {
    return {
      kind: "bare" as const,
      label: "fake exec",
      async run(cmd: string) {
        log.push(cmd);
        return { ok: true, exitCode: 0, output: `OUT(${cmd})` };
      },
      async artifacts() {
        return { location: "fake", files: ["a.py"] };
      },
      async dispose() {
        log.push("__disposed__");
      },
    };
  }

  it("lets an agent call run_shell, see the output, and finish with text", async () => {
    const cfg = defaultConfig();
    const cmds: string[] = [];
    let call = 0;
    const w: Provider = {
      name: "fake",
      model: "w1",
      async generate() {
        return { text: "", model: "w1" };
      },
      async stream(messages: Message[], onChunk) {
        call++;
        if (call === 1) {
          // First turn: agent decides to run a command.
          return {
            text: "",
            model: "w1",
            toolCalls: [{ id: "c1", name: "run_shell", arguments: { command: "node --version" } }],
          };
        }
        // Second turn: the tool result must be visible in the conversation.
        const toolMsg = messages.find((m) => m.role === "tool");
        const final = toolMsg?.content.includes("OUT(node --version)")
          ? "verified via shell"
          : "never saw tool output";
        onChunk(final);
        return { text: final, model: "w1" };
      },
      countTokens: (t) => t.length,
      async healthCheck() {
        return { ok: true };
      },
    };
    const worker: SwarmWorker = { ref: "w1", kind: "nvidia", model: "w1", label: "w1", provider: w };
    const lead: Provider = { ...w, model: "lead" } as Provider;
    const swarm = new CoordinatedSwarm(cfg, [worker], lead, { maxTokens: 200 });

    const exec = fakeExec(cmds);
    const run = await swarm.run("t", {
      synthesize: false,
      executor: exec,
      subtasks: [{ id: "a", title: "A", detail: "da", dependsOn: [] }],
    });

    expect(cmds).toContain("node --version");
    expect(cmds).toContain("__disposed__"); // sandbox torn down after the run
    expect(run.results[0].ok).toBe(true);
    expect(run.results[0].text).toContain("verified via shell");
  });
});
