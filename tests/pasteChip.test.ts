import { describe, it, expect } from "vitest";
import { pasteChip } from "../src/cli/prompt";

// Strip ANSI so we assert on the visible text only.
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("pasteChip", () => {
  it("shows the first line plus a bracketed count of the rest", () => {
    const chip = plain(pasteChip("import asyncio, time\nasync def main():\n    pass"));
    expect(chip).toBe("import asyncio, time [+2 lines]");
  });

  it("uses singular 'line' for a two-line paste", () => {
    expect(plain(pasteChip("first\nsecond"))).toBe("first [+1 line]");
  });

  it("truncates a long first line with an ellipsis", () => {
    const long = "x".repeat(80) + "\nmore";
    const chip = plain(pasteChip(long));
    expect(chip).toBe("x".repeat(48) + "… [+1 line]");
  });
});
