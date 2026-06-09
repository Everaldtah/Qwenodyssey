import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { runEditPipeline, dryRunApply } from "../src/core/editPipeline";
import type { EditBlock } from "../src/core/editBlock";

function scratch(): { dir: string; resolve: (rel: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qod-pipe-"));
  const resolve = (rel: string) => {
    const abs = path.resolve(dir, rel);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new Error("escape");
    return abs;
  };
  return { dir, resolve };
}

const blockText = (p: string, search: string, replace: string) =>
  [p, "<<<<<<< SEARCH", search, "=======", replace, ">>>>>>> REPLACE"].join("\n");

describe("dryRunApply", () => {
  it("returns ok when blocks apply, error when they don't", () => {
    const { dir, resolve } = scratch();
    fs.writeFileSync(path.join(dir, "a.txt"), "hello");
    expect(dryRunApply([{ path: "a.txt", search: "hello", replace: "hi" }], resolve).ok).toBe(true);
    const bad = dryRunApply([{ path: "a.txt", search: "nope", replace: "x" }], resolve);
    expect(bad.ok).toBe(false);
  });

  it("composes sequential blocks against live in-memory content", () => {
    const { dir, resolve } = scratch();
    fs.writeFileSync(path.join(dir, "a.txt"), "x\ny");
    const ok = dryRunApply(
      [
        { path: "a.txt", search: "x", replace: "X" },
        { path: "a.txt", search: "y", replace: "Y" },
      ],
      resolve
    );
    expect(ok.ok).toBe(true);
  });
});

describe("runEditPipeline", () => {
  it("applies the best applying candidate (verify disabled)", async () => {
    const { dir, resolve } = scratch();
    fs.writeFileSync(path.join(dir, "f.ts"), "const v = 1;\n");

    const res = await runEditPipeline(
      async () => blockText("f.ts", "const v = 1;", "const v = 2;"),
      { root: dir, resolve, candidates: 1, maxRepairRounds: 0, runVerify: false }
    );

    expect(res.applied).toBe(true);
    expect(fs.readFileSync(path.join(dir, "f.ts"), "utf-8")).toContain("const v = 2;");
  });

  it("rejects non-applying candidates and reports when none apply", async () => {
    const { dir, resolve } = scratch();
    fs.writeFileSync(path.join(dir, "f.ts"), "const v = 1;\n");

    const res = await runEditPipeline(
      async () => blockText("f.ts", "DOES NOT EXIST", "x"),
      { root: dir, resolve, candidates: 2, maxRepairRounds: 0, runVerify: false }
    );

    expect(res.applied).toBe(false);
    expect(res.message).toMatch(/no candidate/i);
    // File untouched.
    expect(fs.readFileSync(path.join(dir, "f.ts"), "utf-8")).toBe("const v = 1;\n");
  });

  it("prefers a candidate that applies over one that doesn't", async () => {
    const { dir, resolve } = scratch();
    fs.writeFileSync(path.join(dir, "f.ts"), "let count = 0;\n");

    let attempt = 0;
    const res = await runEditPipeline(
      async () => {
        // First candidate is garbage, second is valid.
        attempt++;
        return attempt === 1
          ? blockText("f.ts", "nonexistent line", "x")
          : blockText("f.ts", "let count = 0;", "let count = 99;");
      },
      { root: dir, resolve, candidates: 3, maxRepairRounds: 0, runVerify: false }
    );

    expect(res.applied).toBe(true);
    expect(fs.readFileSync(path.join(dir, "f.ts"), "utf-8")).toContain("let count = 99;");
  });

  it("runs a verify pass and self-repairs using feedback (simulated)", async () => {
    const { dir, resolve } = scratch();
    // A package.json with a 'typecheck' that fails until a marker is present.
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { typecheck: "node check.js" } })
    );
    fs.writeFileSync(
      path.join(dir, "check.js"),
      // Exits 0 only if target.txt contains 'FIXED'.
      "const fs=require('fs');const t=fs.existsSync('target.txt')?fs.readFileSync('target.txt','utf8'):'';process.exit(t.includes('FIXED')?0:1);"
    );
    fs.writeFileSync(path.join(dir, "target.txt"), "BROKEN");

    let round = 0;
    const res = await runEditPipeline(
      async (_attempt, feedback) => {
        round++;
        // Round 1: an edit that applies but won't satisfy the check.
        // Repair round: once we see verify feedback, fix it properly.
        if (feedback) return blockText("target.txt", "STILL_BROKEN", "FIXED");
        return blockText("target.txt", "BROKEN", "STILL_BROKEN");
      },
      {
        root: dir,
        resolve,
        candidates: 1,
        maxRepairRounds: 2,
        runVerify: true,
        verifyOnly: ["typecheck"],
      }
    );

    expect(res.applied).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.rounds).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(path.join(dir, "target.txt"), "utf-8")).toContain("FIXED");
  });
});
