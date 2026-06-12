import { describe, it, expect, afterAll } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { expandHome, resolveReadable, resolveReadableSmart } from "../src/tools/fileTools";

describe("expandHome", () => {
  it("expands a bare ~ and ~/ to the home directory", () => {
    expect(expandHome("~")).toBe(os.homedir());
    expect(expandHome("~/.qwenodyssey/config.toml")).toBe(
      path.join(os.homedir(), ".qwenodyssey", "config.toml")
    );
  });

  it("leaves non-tilde paths untouched", () => {
    expect(expandHome("src/index.ts")).toBe("src/index.ts");
    expect(expandHome("/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("resolveReadable", () => {
  it("resolves ~ against home, not the cwd", () => {
    const r = resolveReadable("C:/some/where", "~/.qwenodyssey");
    expect(r).toBe(path.resolve(os.homedir(), ".qwenodyssey"));
  });
});

describe("resolveReadableSmart (home fallback)", () => {
  // A real file in the home dir so the fallback has something to find.
  const marker = `.qod-test-${process.pid}-${Date.now()}`;
  const markerAbs = path.join(os.homedir(), marker);
  fs.writeFileSync(markerAbs, "x");
  afterAll(() => {
    try {
      fs.unlinkSync(markerAbs);
    } catch {
      /* ignore */
    }
  });

  it("never overrides a correct, existing absolute path", () => {
    // __filename exists, so it must be returned as-is.
    expect(resolveReadableSmart("C:/anything", __filename)).toBe(path.resolve(__filename));
  });

  it("redirects a leading-slash dotfile that doesn't exist to the home-rooted match", () => {
    // "/<marker>" resolves to the drive root (non-existent) → falls back to ~/<marker>.
    const r = resolveReadableSmart("C:/some/other/cwd", "/" + marker);
    expect(r).toBe(markerAbs);
  });

  it("redirects a bare home-relative path when cwd is not home", () => {
    const r = resolveReadableSmart(path.join(os.tmpdir(), "not-home"), marker);
    expect(r).toBe(markerAbs);
  });

  it("returns the primary resolution when no home match exists", () => {
    const r = resolveReadableSmart("C:/some/cwd", "/definitely/not/here-" + marker);
    expect(r).toBe(path.resolve("C:/some/cwd", "/definitely/not/here-" + marker));
  });
});
