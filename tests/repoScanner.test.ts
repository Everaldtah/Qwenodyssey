import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { scanRepo } from "../src/core/repoScanner";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qo-scan-"));
  // The temp dir may live inside a parent git repo (e.g. the user's home).
  // Give it its own repo so `git status` is scoped to this small tree and fast.
  try {
    execSync("git init -q", { cwd: dir, stdio: "ignore" });
  } catch {
    /* git not available — scanRepo still works, just reports hasGit=false */
  }
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("scanRepo", () => {
  it("detects a Node project and its package manager + test script", async () => {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "vitest" }, dependencies: { express: "^4" } })
    );
    fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "index.js"), "console.log(1)");

    const info = await scanRepo(dir);
    expect(info.languages.join()).toContain("JavaScript");
    expect(info.packageManager).toBe("npm");
    expect(info.testCommand).toBe("npm run test");
    expect(info.framework).toBe("Express");
    expect(info.entrypoints).toContain("src/index.js");
  });

  it("detects a Python project", async () => {
    fs.writeFileSync(path.join(dir, "requirements.txt"), "fastapi\nuvicorn\n");
    const info = await scanRepo(dir);
    expect(info.languages.join()).toContain("Python");
    expect(info.testCommand).toBe("pytest");
    expect(info.framework).toBe("FastAPI");
  });

  it("detects a Rust project", async () => {
    fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname='x'\n");
    const info = await scanRepo(dir);
    expect(info.languages.join()).toContain("Rust");
    expect(info.testCommand).toBe("cargo test");
  });
});
