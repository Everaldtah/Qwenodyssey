import { describe, it, expect } from "vitest";
import { classifyCommand } from "../src/tools/shellTools";

describe("classifyCommand", () => {
  it("hard-blocks catastrophic commands", () => {
    expect(classifyCommand("rm -rf /")).toBe("blocked");
    expect(classifyCommand("sudo rm -rf /")).toBe("blocked");
    expect(classifyCommand("mkfs.ext4 /dev/sda1")).toBe("blocked");
    expect(classifyCommand("dd if=/dev/zero of=/dev/sda")).toBe("blocked");
    expect(classifyCommand("shutdown now")).toBe("blocked");
    expect(classifyCommand(":(){ :|:& };:")).toBe("blocked");
  });

  it("flags destructive-but-allowed commands", () => {
    expect(classifyCommand("rm file.txt")).toBe("destructive");
    expect(classifyCommand("git reset --hard HEAD~1")).toBe("destructive");
    expect(classifyCommand("git push origin main --force")).toBe("destructive");
  });

  it("passes ordinary commands", () => {
    expect(classifyCommand("ls -la")).toBe("safe");
    expect(classifyCommand("npm test")).toBe("safe");
    expect(classifyCommand("git status")).toBe("safe");
  });
});
