/**
 * `qwenodyssey miclevel` — a live, animated VU meter that reacts to your voice so
 * you can confirm the microphone is actually working before a live session. Reads
 * real RMS levels from the mic via ffmpeg and flags when you're speaking.
 */
import * as readline from "readline";
import chalk from "chalk";
import { createSession, GlobalOpts } from "../session";
import { resolveFfmpeg, pickAudioDevice, pickVideoDevice, startLevelMeter } from "../../core/media";

const WIDTH = 36; // bar width in cells
const FLOOR = -70; // dB mapped to an empty bar
const SPEAK_DB = -38; // above this ≈ speaking

export async function miclevelCommand(opts: GlobalOpts): Promise<void> {
  const s = createSession(opts);
  const cfg = s.config;
  const ffmpeg = resolveFfmpeg();
  const cam = cfg.vision.enabled ? await pickVideoDevice(cfg.vision.device, ffmpeg).catch(() => null) : null;
  const mic = await pickAudioDevice(cfg.audio.device, cam, ffmpeg).catch(() => null);

  console.log(chalk.bold("\n  Qwenodyssey — microphone level meter\n"));
  if (!mic) {
    console.log(chalk.red("  No microphone found. Set audio.device or check Windows mic privacy.\n"));
    return;
  }
  console.log(chalk.gray("  mic: ") + mic);
  console.log(chalk.gray("  Speak — the bar should move. Press q or Ctrl-C to stop.\n"));

  // Smoothed display value + a slowly-falling peak marker for a lively animation.
  let level = 0; // 0..1
  let peak = 0;
  let lastDb = -90;
  let speaking = false;

  const onLevel = (db: number) => {
    lastDb = db;
    const target = Math.max(0, Math.min(1, (db - FLOOR) / (0 - FLOOR)));
    // Attack fast, release slow → natural VU feel.
    level += (target - level) * (target > level ? 0.6 : 0.25);
    if (level > peak) peak = level;
    speaking = db > SPEAK_DB;
  };
  const meter = startLevelMeter(mic, onLevel, ffmpeg);

  const render = () => {
    peak = Math.max(0, peak - 0.02); // peak slowly falls
    const filled = Math.round(level * WIDTH);
    const peakCell = Math.min(WIDTH - 1, Math.round(peak * WIDTH));
    let bar = "";
    for (let i = 0; i < WIDTH; i++) {
      if (i === peakCell && peakCell >= filled) bar += chalk.white("│");
      else if (i < filled) {
        const frac = i / WIDTH;
        bar += frac > 0.85 ? chalk.red("█") : frac > 0.6 ? chalk.yellow("█") : chalk.green("█");
      } else bar += chalk.gray("─");
    }
    const tag = speaking ? chalk.greenBright("● SPEAKING") : chalk.gray("· quiet   ");
    const db = lastDb <= -90 ? " -inf" : lastDb.toFixed(0).padStart(4);
    process.stdout.write(`\r  🎤 [${bar}] ${chalk.gray(db + " dB")}  ${tag}`);
  };
  const timer = setInterval(render, 60);
  timer.unref?.();

  await new Promise<void>((resolve) => {
    const stdin = process.stdin;
    const tty = !!stdin.isTTY;
    if (tty) {
      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
    }
    const cleanup = () => {
      clearInterval(timer);
      meter.stop();
      try {
        if (tty) stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
      stdin.removeListener("keypress", onKey);
      process.stdout.write("\r\x1b[2K");
      console.log(chalk.gray("\n  meter stopped.\n"));
      resolve();
    };
    const onKey = (_s: string | undefined, key: readline.Key) => {
      if (key && (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c"))) cleanup();
    };
    if (tty) stdin.on("keypress", onKey);
  });
}
