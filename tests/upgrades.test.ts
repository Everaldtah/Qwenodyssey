import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { SessionStore, deriveTitle } from "../src/core/sessionStore";
import { createPlanTool, renderPlan, PlanState } from "../src/tools/planTool";
import { historyTokens, shouldCompact, compactHistory } from "../src/core/compactor";
import type { Message, ToolContext } from "../src/types";

// Minimal provider stub for the compactor (token estimate + canned summary).
const fakeProvider: any = {
  name: "stub",
  model: "stub",
  countTokens: (t: string) => Math.ceil((t || "").length / 4),
  generate: async () => ({ text: "COMPACT SUMMARY", model: "stub" }),
  stream: async () => ({ text: "", model: "stub" }),
  healthCheck: async () => ({ ok: true }),
};

const ctx: ToolContext = { cwd: ".", autoConfirm: true, confirmDestructive: false, allowShell: true, sandbox: true, log: () => {} };

describe("SessionStore", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qod-sess-"));
  const store = new SessionStore(dir);

  it("round-trips a session and lists it", () => {
    const id = store.newId();
    const messages: Message[] = [
      { role: "user", content: "fix the build" },
      { role: "assistant", content: "done" },
    ];
    store.save({ id, cwd: "C:/proj", title: deriveTitle(messages), model: "m", provider: "p", createdAt: "t0", updatedAt: "t1", turns: 1, messages });
    const loaded = store.load(id);
    expect(loaded?.messages.length).toBe(2);
    expect(store.list().some((m) => m.id === id)).toBe(true);
  });

  it("derives a title from the first user message, stripping a recall prefix", () => {
    expect(deriveTitle([{ role: "user", content: "recall blah ——— actual question here" }])).toBe("actual question here");
    expect(deriveTitle([{ role: "assistant", content: "x" }])).toBe("(empty session)");
  });

  it("newId is time-sortable and unique", () => {
    const a = store.newId();
    const b = store.newId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/);
  });
});

describe("planTool", () => {
  it("stores the plan, coerces statuses, and renders checkboxes", async () => {
    const state: PlanState = { items: [] };
    const tool = createPlanTool(state);
    const r = await tool.run({ plan: [
      { step: "scan repo", status: "done" },
      { step: "edit file", status: "in_progress" },
      { step: "run tests", status: "todo" }, // unknown -> pending
    ] }, ctx);
    expect(r.ok).toBe(true);
    expect(state.items.length).toBe(3);
    expect(state.items[2].status).toBe("pending");
    const out = renderPlan(state.items);
    expect(out).toContain("[x] 1. scan repo");
    expect(out).toContain("[~] 2. edit file");
    expect(out).toContain("[ ] 3. run tests");
  });

  it("rejects an empty plan", async () => {
    const tool = createPlanTool({ items: [] });
    const r = await tool.run({ plan: [] }, ctx);
    expect(r.ok).toBe(false);
  });
});

describe("compactor", () => {
  const sys: Message = { role: "system", content: "SYS" };
  const big = (label: string): Message[] => [
    { role: "user", content: (label + " ").repeat(200) },
    { role: "assistant", content: (label + " ").repeat(200) },
  ];

  it("historyTokens grows with content and shouldCompact respects the budget", () => {
    const small: Message[] = [sys, { role: "user", content: "hi" }];
    expect(historyTokens(small, fakeProvider)).toBeGreaterThan(0);
    expect(shouldCompact(small, fakeProvider, { contextTokens: 16384, maxTokens: 4096 })).toBe(false);
    // ~16 messages × ~400 tokens ≈ 6400 tokens, comfortably over the ~5.5k threshold
    // for a 8k context with 1k answer headroom (usable≈6488, compact at 85%).
    const huge: Message[] = [sys];
    for (let i = 0; i < 8; i++) huge.push(...big("x".repeat(1600)));
    expect(historyTokens(huge, fakeProvider)).toBeGreaterThan(5514);
    expect(shouldCompact(huge, fakeProvider, { contextTokens: 8000, maxTokens: 1000 })).toBe(true);
  });

  it("compacts older turns, folds a summary into the system msg, and keeps recent turns", async () => {
    const messages: Message[] = [
      sys,
      { role: "user", content: "u1" }, { role: "assistant", content: "a1" },
      { role: "user", content: "u2" }, { role: "assistant", content: "a2" },
      { role: "user", content: "u3" }, { role: "assistant", content: "a3" },
      { role: "user", content: "u4" },
    ];
    const r = await compactHistory(messages, fakeProvider, { keepUserTurns: 2 });
    expect(r.compacted).toBe(true);
    expect(r.removed).toBe(4); // u1,a1,u2,a2
    const nm = r.newMessages!;
    expect(nm[0].role).toBe("system");
    expect(nm[0].content).toContain("COMPACT SUMMARY");
    // first non-system message is a user turn boundary (u3), so no dangling tool group
    expect(nm[1]).toMatchObject({ role: "user", content: "u3" });
    expect(nm[nm.length - 1]).toMatchObject({ role: "user", content: "u4" });
  });

  it("does nothing when there are too few turns to compact", async () => {
    const r = await compactHistory([sys, { role: "user", content: "only" }], fakeProvider, { keepUserTurns: 3 });
    expect(r.compacted).toBe(false);
  });
});
