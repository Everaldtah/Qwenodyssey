import { describe, it, expect } from "vitest";
import { defaultConfig } from "../src/core/config";
import {
  CoordinatedSwarm,
  Blackboard,
  parsePlan,
  decompose,
  decomposeWith,
  type Subtask,
} from "../src/core/swarmCoordinator";
import type { Provider, Message } from "../src/types";
import type { SwarmWorker } from "../src/core/swarm";

/** Minimal fake provider: drives generate()/stream() from supplied callbacks. */
function fakeProvider(opts: {
  model?: string;
  onGenerate?: (m: Message[]) => string;
  onStream?: (m: Message[]) => string;
}): Provider {
  return {
    name: "fake",
    model: opts.model ?? "fake-model",
    async generate(messages) {
      return { text: opts.onGenerate ? opts.onGenerate(messages) : "", model: this.model };
    },
    async stream(messages, onChunk) {
      const text = opts.onStream ? opts.onStream(messages) : "";
      onChunk(text); // single-chunk stream is enough to exercise the path
      return { text, model: this.model };
    },
    countTokens: (t) => t.length,
    async healthCheck() {
      return { ok: true };
    },
  };
}

function worker(p: Provider): SwarmWorker {
  return { ref: p.model, kind: "nvidia", model: p.model, label: p.model, provider: p };
}

const userOf = (msgs: Message[]) => msgs.find((m) => m.role === "user")?.content ?? "";

describe("parsePlan", () => {
  it("extracts subtasks from fenced/prose-wrapped JSON and drops dangling deps", () => {
    const text =
      "Here is the plan:\n```json\n" +
      JSON.stringify({
        subtasks: [
          { id: "a", title: "A", detail: "do a", dependsOn: [] },
          { id: "b", title: "B", detail: "do b", dependsOn: ["a", "ghost"] },
        ],
      }) +
      "\n```\nGood luck.";
    const plan = parsePlan(text);
    expect(plan.map((s) => s.id)).toEqual(["a", "b"]);
    // "ghost" references no real subtask → removed so scheduling can't deadlock.
    expect(plan[1].dependsOn).toEqual(["a"]);
  });

  it("returns [] when there is no JSON", () => {
    expect(parsePlan("no json here at all")).toEqual([]);
  });
});

describe("Blackboard", () => {
  const subs: Subtask[] = [
    { id: "a", title: "A", detail: "da", dependsOn: [] },
    { id: "b", title: "B", detail: "db", dependsOn: ["a"] },
  ];

  it("only releases a subtask once its dependencies are resolved", () => {
    const board = new Blackboard(subs);
    expect(board.ready().map((e) => e.id)).toEqual(["a"]);

    const a = board.get("a")!;
    a.status = "done";
    a.result = "ALPHA-RESULT";
    expect(board.ready().map((e) => e.id)).toEqual(["b"]);
  });

  it("injects a dependency's result into the dependent's context digest", () => {
    const board = new Blackboard(subs);
    const a = board.get("a")!;
    a.status = "done";
    a.result = "ALPHA-RESULT";

    const digest = board.digestFor("b");
    expect(digest).toContain("ALPHA-RESULT"); // the actual result is shared
    expect(digest).toContain("[a] A"); // labeled by id/title
    expect(digest).toContain("TEAM PLAN"); // peer awareness section
  });
});

describe("CoordinatedSwarm.run", () => {
  it("runs subtasks in dependency order, shares context, and isolates failures", async () => {
    const cfg = defaultConfig();
    const lead = fakeProvider({ model: "lead", onStream: () => "INTEGRATED" });

    // One worker so a→b are forced sequential; b must SEE a's result via the board.
    const w = fakeProvider({
      model: "w1",
      onStream: (msgs) => {
        const u = userOf(msgs);
        if (u.includes("YOUR SUBTASK [a]")) return "RESULT-A";
        if (u.includes("YOUR SUBTASK [b]")) return u.includes("RESULT-A") ? "B-SAW-A" : "B-BLIND";
        if (u.includes("YOUR SUBTASK [c]")) throw new Error("boom");
        return "?";
      },
    });

    const swarm = new CoordinatedSwarm(cfg, [worker(w)], lead, { maxTokens: 500 });

    let planned = 0;
    let done = false;
    swarm.events.on("plan", () => planned++);
    swarm.events.on("done", () => (done = true));

    const run = await swarm.run("the overall task", {
      subtasks: [
        { id: "a", title: "A", detail: "da", dependsOn: [] },
        { id: "b", title: "B", detail: "db", dependsOn: ["a"] },
        { id: "c", title: "C", detail: "dc", dependsOn: [] },
      ],
    });

    const byId = Object.fromEntries((run.results as any[]).map((r) => [r.id, r]));
    expect(byId.a.text).toBe("RESULT-A");
    expect(byId.b.text).toBe("B-SAW-A"); // built on the dependency's output
    expect(byId.c.ok).toBe(false); // failed, but did not block a/b
    expect(byId.c.error).toContain("boom");

    expect(run.synthesis).toBe("INTEGRATED");
    expect(run.synthesizedBy).toBe("lead");
    expect(planned).toBe(1);
    expect(done).toBe(true);
  });

  it("passes the real overall task into each agent's prompt", async () => {
    const cfg = defaultConfig();
    const lead = fakeProvider({ model: "lead", onStream: () => "X" });
    let sawTask = false;
    const w = fakeProvider({
      model: "w1",
      onStream: (msgs) => {
        if (userOf(msgs).includes("OVERALL TASK:\nbuild a parser")) sawTask = true;
        return "ok";
      },
    });
    const swarm = new CoordinatedSwarm(cfg, [worker(w)], lead, { maxTokens: 200 });
    await swarm.run("build a parser", {
      synthesize: false,
      subtasks: [{ id: "a", title: "A", detail: "da", dependsOn: [] }],
    });
    expect(sawTask).toBe(true);
  });
});

describe("decompose", () => {
  it("parses a valid plan from the lead", async () => {
    const lead = fakeProvider({
      onGenerate: () =>
        JSON.stringify({ subtasks: [{ id: "x", title: "X", detail: "dx", dependsOn: [] }] }),
    });
    const subs = await decompose(lead, "t", 2, 500);
    expect(subs.map((s) => s.id)).toEqual(["x"]);
  });

  it("degrades to a single whole-task subtask when the lead returns no JSON", async () => {
    const lead = fakeProvider({ onGenerate: () => "sorry, no plan" });
    const subs = await decompose(lead, "the big task", 3, 500);
    expect(subs).toHaveLength(1);
    expect(subs[0].detail).toBe("the big task");
  });
});

describe("decomposeWith (planner ladder)", () => {
  const goodPlan = JSON.stringify({
    subtasks: [{ id: "x", title: "X", detail: "dx", dependsOn: [] }],
  });

  it("falls through to the next candidate when the first times out", async () => {
    const slow = fakeProvider({
      model: "slow-lead",
      onGenerate: () => {
        throw new Error("nvidia request timed out after 90000ms");
      },
    });
    const fast = fakeProvider({ model: "fast-lead", onGenerate: () => goodPlan });
    const attempts: string[] = [];
    const res = await decomposeWith([slow, fast], "t", 2, 500, undefined, (m) => attempts.push(m));
    expect(res.subtasks.map((s) => s.id)).toEqual(["x"]);
    expect(res.plannedBy).toBe("fast-lead");
    expect(res.note).toContain("slow-lead");
    expect(attempts).toEqual(["slow-lead", "fast-lead"]);
  });

  it("skips a candidate that returns unparseable text", async () => {
    const vague = fakeProvider({ model: "vague", onGenerate: () => "no json from me" });
    const fast = fakeProvider({ model: "fast", onGenerate: () => goodPlan });
    const res = await decomposeWith([vague, fast], "t", 2, 500);
    expect(res.plannedBy).toBe("fast");
  });

  it("degrades to a single subtask with a note when every candidate fails", async () => {
    const bad1 = fakeProvider({
      model: "b1",
      onGenerate: () => {
        throw new Error("boom1");
      },
    });
    const bad2 = fakeProvider({ model: "b2", onGenerate: () => "nope" });
    const res = await decomposeWith([bad1, bad2], "whole task", 2, 500);
    expect(res.subtasks).toHaveLength(1);
    expect(res.subtasks[0].detail).toBe("whole task");
    expect(res.plannedBy).toBe("(fallback)");
    expect(res.note).toContain("boom1");
  });
});

describe("plan event diagnostics", () => {
  it("reports plannedBy '(supplied)' for pre-supplied subtasks", async () => {
    const cfg = defaultConfig();
    const lead = fakeProvider({ model: "lead", onStream: () => "X" });
    const w = fakeProvider({ model: "w1", onStream: () => "ok" });
    const swarm = new CoordinatedSwarm(cfg, [worker(w)], lead, { maxTokens: 200 });
    let plannedBy = "";
    swarm.events.on("plan", (e: any) => (plannedBy = e.plannedBy));
    await swarm.run("t", {
      synthesize: false,
      subtasks: [{ id: "a", title: "A", detail: "da", dependsOn: [] }],
    });
    expect(plannedBy).toBe("(supplied)");
  });
});
