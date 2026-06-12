/**
 * End-to-end probe: runs the REAL `qwenodyssey swarm --demo` inside a ConPTY and
 * verifies the full coordinated path renders (panes, waves, streaming, synthesis)
 * exactly as a user's terminal would receive it. No network, no tokens.
 */
const fs = require("fs");
const path = require("path");
const pty = require("node-pty");

const repo = path.resolve(__dirname, "..");
const child = pty.spawn(
  process.execPath,
  [path.join(repo, "dist", "cli", "index.js"), "swarm", "--demo"],
  { name: "xterm-256color", cols: 140, rows: 42, cwd: repo, env: process.env }
);

let out = "";
child.onData((d) => (out += d));

const finish = (exitCode) => {
  fs.writeFileSync(path.join(repo, "scripts", "demo_capture.txt"), out, "utf8");
  const has = (s) => out.includes(s);
  console.log("--- demo pty analysis ---");
  console.log("exitCode:", exitCode);
  console.log("bytes:", out.length);
  console.log("alt-screen on/off:", has("\x1b[?1049h"), has("\x1b[?1049l"));
  console.log("pane borders:", has("┌"), has("│"));
  console.log("agent labels:", has("kimi"), has("nemotron"), has("llama"), has("deepseek"));
  console.log("wave 1 header:", has("wave 1"));
  console.log("wave 2 header:", has("wave 2"));
  console.log("streamed text:", has("Drafting the core architecture"));
  console.log("done glyph ✓:", has("✓"));
  console.log("synthesizing line:", has("synthesizing"));
  console.log("frames painted:", (out.match(/\x1b\[H/g) || []).length);
  console.log("clean finish:", has("demo finished"));
  process.exit(0);
};

child.onExit(({ exitCode }) => finish(exitCode));
// Hard stop in case the demo wedges.
setTimeout(() => {
  try {
    child.kill();
  } catch {}
  finish("(timeout)");
}, 60000);
