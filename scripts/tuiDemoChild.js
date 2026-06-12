/**
 * TUI probe child: drives the real SwarmTui with synthetic events (no network).
 * Run inside a real TTY/ConPTY; prints a TTY banner, paints ~2s of frames, exits.
 * Used by scripts/tuiPtyProbe.js and manually: `node scripts/tuiDemoChild.js`.
 */
const { SwarmTui } = require("../dist/cli/swarmTui.js");
const { SwarmEvents } = require("../dist/core/swarmCoordinator.js");

console.log(
  `probe: isTTY=${!!process.stdout.isTTY} cols=${process.stdout.columns} rows=${process.stdout.rows} supported=${SwarmTui.supported()}`
);

const ev = new SwarmEvents();
const tui = new SwarmTui(ev, { task: "demo: four fake agents streaming", panes: 4 });
tui.start();

const roster = ["kimi-k2.6", "nemotron-3-ultra", "llama-3.3-70b", "deepseek-chat"];
ev.emit("plan", {
  task: "demo",
  subtasks: roster.map((_, i) => ({ id: `s${i + 1}`, title: `subtask ${i + 1}`, detail: "d", dependsOn: [] })),
  roster: roster.map((m) => ({ label: m, model: m, backend: "demo" })),
});
ev.emit("wave", { index: 0, subtaskIds: ["s1", "s2", "s3", "s4"] });
for (let i = 0; i < 4; i++) {
  ev.emit("assign", { pane: i, subtaskId: `s${i + 1}`, title: `subtask ${i + 1}`, workerLabel: roster[i], model: roster[i] });
  ev.emit("status", { pane: i, subtaskId: `s${i + 1}`, status: "running" });
}

const WORDS = "the quick brown fox jumps over the lazy dog and keeps streaming tokens live ".split(" ");
let tick = 0;
const feeder = setInterval(() => {
  tick++;
  for (let i = 0; i < 4; i++) {
    ev.emit("delta", { pane: i, subtaskId: `s${i + 1}`, delta: WORDS[(tick + i) % WORDS.length] + " " });
  }
  if (tick === 12) {
    ev.emit("status", { pane: 1, subtaskId: "s2", status: "done", ms: 1200 });
    ev.emit("status", { pane: 3, subtaskId: "s4", status: "failed", ms: 900, error: "demo error" });
  }
  if (tick >= 20) {
    clearInterval(feeder);
    setTimeout(() => {
      tui.stop();
      console.log("probe: stopped cleanly");
      process.exit(0);
    }, 250);
  }
}, 100);
