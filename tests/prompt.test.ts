import { describe, it, expect } from "vitest";
import { wrapRows, pasteChip } from "../src/cli/prompt";

describe("wrapRows — physical rows a wrapped input line spills onto", () => {
  it("fits on one row when at or under the terminal width", () => {
    expect(wrapRows(0, 80)).toBe(0);
    expect(wrapRows(1, 80)).toBe(0);
    expect(wrapRows(79, 80)).toBe(0);
    // Exactly full width: deferred-wrap keeps the cursor on the same row.
    expect(wrapRows(80, 80)).toBe(0);
  });

  it("counts an extra row once the input crosses the edge", () => {
    expect(wrapRows(81, 80)).toBe(1);
    expect(wrapRows(160, 80)).toBe(1);
    expect(wrapRows(161, 80)).toBe(2);
    expect(wrapRows(240, 80)).toBe(2);
  });

  it("is safe for degenerate widths", () => {
    expect(wrapRows(50, 0)).toBe(0);
    expect(wrapRows(-5, 80)).toBe(0);
  });
});

describe("pasteChip", () => {
  it("collapses a multi-line paste to a one-line chip", () => {
    const chip = pasteChip("first line\nsecond\nthird");
    expect(chip).toContain("first line");
    expect(chip).toContain("[+2 lines]");
  });
});
