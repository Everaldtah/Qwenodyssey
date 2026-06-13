/**
 * Render a SINGLE swarm TUI frame to plain text (no alt-screen, no live loop) so a
 * painted frame can be eyeballed in logs. Drives renderPane via the public draw
 * path by faking a small stdout. Prints the last full frame's visible lines.
 */
const { SwarmTui } = require("../dist/cli/swarmTui.js");
const { SwarmEvents } = require("../dist/core/swarmCoordinator.js");

// Fake a TTY stdout that captures writes instead of emitting escape codes live.
let captured = "";
const fake = {
  isTTY: true,
  columns: 100,
  rows: 24,
  write: (s) => {
    captured += s;
    return true;
  },
};
const realDesc = Object.getOwnPropertyDescriptor(process, "stdout");
Object.defineProperty(process, "stdout", { value: fake, configurable: true });

const ev = new SwarmEvents();
const tui = new SwarmTui(ev, {
  task: "render one frame",
  panes: 4,
  cwd: "C:\\Users\\evera",
  roster: [
    { label: "kimi-k2.6", model: "moonshotai/kimi-k2.6", backend: "nvidia" },
    { label: "nemotron-3-ultra", model: "nvidia/nemotron-3-ultra-550b-a55b", backend: "nvidia" },
    { label: "llama-3.3-70b", model: "meta/llama-3.3-70b-instruct", backend: "nvidia" },
    { label: "deepseek-chat", model: "deepseek/deepseek-chat", backend: "openrouter" },
  ],
});
tui.start();
ev.emit("plan", {
  task: "render one frame",
  subtasks: [1, 2, 3, 4].map((i) => ({ id: "s" + i, title: "subtask " + i, detail: "d", dependsOn: [] })),
  roster: [
    { label: "kimi-k2.6", model: "moonshotai/kimi-k2.6", backend: "nvidia" },
    { label: "nemotron-3-ultra", model: "nvidia/nemotron-3-ultra-550b-a55b", backend: "nvidia" },
    { label: "llama-3.3-70b", model: "meta/llama-3.3-70b-instruct", backend: "nvidia" },
    { label: "deepseek-chat", model: "deepseek/deepseek-chat", backend: "openrouter" },
  ],
  complexity: "complex",
  exec: "daytona sandbox",
});
const FULL = ["moonshotai/kimi-k2.6", "nvidia/nemotron-3-ultra-550b-a55b", "meta/llama-3.3-70b-instruct", "deepseek/deepseek-chat"];
[0, 1, 2, 3].forEach((i) => {
  ev.emit("assign", { pane: i, subtaskId: "s" + (i + 1), title: "subtask " + (i + 1), workerLabel: ["kimi-k2.6", "nemotron-3-ultra", "llama-3.3-70b", "deepseek-chat"][i], model: FULL[i] });
  ev.emit("status", { pane: i, subtaskId: "s" + (i + 1), status: "running" });
  ev.emit("delta", { pane: i, subtaskId: "s" + (i + 1), delta: "working on the subtask, streaming tokens here... " });
});

setTimeout(() => {
  // Drive a synthesis + completion so the results pane is populated.
  ev.emit("synth", { model: "nvidia/nemotron-3-ultra-550b-a55b" });
  ev.emit("synthDelta", { delta: "# Final report\nBuilt the rate limiter. " });
  tui.complete({
    mode: "divide",
    results: [{ id: "s1", title: "subtask 1", ok: true, text: "ok", ms: 1000, model: "m", backend: "nvidia", task: "", dependsOn: [] }],
    synthesis: "# Final report\n\nBuilt a production rate-limiter (sliding-window + token bucket).\n\n```python\nclass RateLimiter: ...\n```\n\nRun: `python app.py`.",
    synthesizedBy: "nvidia/nemotron-3-ultra-550b-a55b",
    artifacts: { location: "bare metal: C:\\Users\\evera", files: ["C:\\Users\\evera\\ratelimiter.py", "C:\\Users\\evera\\test_rl.py"] },
  });
  captured = "";
  setTimeout(() => {
    tui.stop();
    Object.defineProperty(process, "stdout", realDesc);
    const frames = captured.split("\x1b[H");
    const last = (frames[frames.length - 1] || "")
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/\x1b\][^\x07]*\x07/g, "");
    process.stdout.write(last.split("\n").slice(0, 24).join("\n") + "\n");
    process.exit(0);
  }, 250);
}, 200);
