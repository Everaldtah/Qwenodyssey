/**
 * TUI probe runner: spawns tuiDemoChild.js inside a REAL ConPTY (node-pty) and
 * captures every byte the TUI writes, so rendering can be verified/diagnosed
 * without a human watching a terminal. Writes the raw capture to
 * scripts/tui_capture.bin and prints a quick analysis.
 */
const fs = require("fs");
const path = require("path");
const pty = require("node-pty");

const repo = path.resolve(__dirname, "..");
const child = pty.spawn(process.execPath, [path.join(repo, "scripts", "tuiDemoChild.js")], {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd: repo,
  env: process.env,
});

let out = "";
child.onData((d) => (out += d));
child.onExit(({ exitCode }) => {
  const file = path.join(repo, "scripts", "tui_capture.bin");
  fs.writeFileSync(file, out, "utf8");
  const has = (s) => out.includes(s);
  console.log("--- pty capture analysis ---");
  console.log("exitCode:", exitCode);
  console.log("bytes captured:", out.length);
  console.log("alt-screen on  (\\x1b[?1049h):", has("\x1b[?1049h"));
  console.log("alt-screen off (\\x1b[?1049l):", has("\x1b[?1049l"));
  console.log("cursor home    (\\x1b[H):", has("\x1b[H"));
  console.log("pane border ┌:", has("┌"));
  console.log("pane border │:", has("│"));
  console.log("streamed words:", has("quick brown"));
  console.log("done glyph ✓:", has("✓"));
  console.log("failed glyph ✗:", has("✗"));
  console.log("tty banner:", /probe: isTTY=true/.test(out));
  console.log("clean stop:", has("probe: stopped cleanly"));
  // Rough frame count: number of cursor-home writes.
  const frames = (out.match(/\x1b\[H/g) || []).length;
  console.log("frames painted:", frames);
  // node-pty's conpty teardown can keep the process alive (benign AttachConsole
  // artifact) — exit explicitly once the analysis is printed.
  process.exit(0);
});
