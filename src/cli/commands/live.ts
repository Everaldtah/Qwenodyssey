/**
 * `qwenodyssey live` — a hands-free, continuous voice+vision conversation.
 *
 * Pipeline (senses local, brain remote, voice local):
 *   mic ─▶ whisper.cpp stream (local STT, voice-activity detection) ─┐
 *                                                                     ├▶ frontier model ─▶ reply ─▶ Piper TTS ─▶ speakers
 *   camera frame ─▶ local vision model (Ollama, e.g. moondream) ──────┘
 *
 * You just talk — whisper-stream segments your speech with VAD (no push-to-talk).
 * On each utterance a fresh camera frame is described locally and bundled with
 * your words for the frontier model; its reply is spoken aloud. Listening is
 * muted while it speaks (so it doesn't transcribe its own voice).
 */
import * as readline from "readline";
import execa from "execa";
import chalk from "chalk";
import { createSession, GlobalOpts } from "../session";
import { Spinner, thinkingWord } from "../render";
import type { Message } from "../../types";
import {
  resolveFfmpeg,
  resolveWhisperStream,
  defaultWhisperModel,
  pickVideoDevice,
  captureFrame,
} from "../../core/media";
import { describeImage } from "../../core/vision";
import { speak, ttsAvailable } from "../../core/tts";

const LIVE_SYSTEM =
  "You are Qwenodyssey in LIVE mode: a hands-free spoken conversation. The user talks to you " +
  "(their speech is transcribed, so expect minor errors) and shares what their webcam sees. Lines " +
  "prefixed with [Camera view: …] are an automatic description of the CURRENT camera frame — treat " +
  "them as your own eyes, not the user's words. Your replies are SPOKEN ALOUD, so be brief, natural, " +
  "and conversational; avoid code blocks, lists, and long output unless asked.";

/**
 * whisper-stream (--step 0 / VAD) prints each utterance as a block:
 *   ### Transcription N START | t0 = … | t1 = …
 *   <the transcribed text, possibly several lines>
 *   ### Transcription N END
 * We capture the text BETWEEN the markers — never the marker line itself.
 */
const RE_START = /^###\s*Transcription\s+\d+\s+START/i;
const RE_END = /^###\s*Transcription\s+\d+\s+END/i;

/** Clean a captured segment: drop ANSI, bracketed non-speech tags, leading dots. */
function extractSpeech(seg: string): string {
  let t = seg.replace(/\x1b\[[0-9;]*[A-Za-z]/g, " ");
  t = t.replace(/\[(?:blank_audio|inaudible|music|silence|noise|sound)\]/gi, " ");
  t = t.replace(/\s+/g, " ").replace(/^[\s.\-]+/, "").trim();
  // Need at least a couple of word characters to count as a real utterance.
  return (t.match(/[a-z0-9]/gi)?.length ?? 0) >= 2 ? t : "";
}

export async function liveCommand(opts: GlobalOpts): Promise<void> {
  const s = createSession(opts);
  const cfg = s.config;
  const ffmpeg = resolveFfmpeg();

  const cam = cfg.vision.enabled ? await pickVideoDevice(cfg.vision.device, ffmpeg).catch(() => null) : null;
  const whisperStream = resolveWhisperStream();
  const model = cfg.audio.whisper_model || defaultWhisperModel();
  const tts = ttsAvailable(cfg);

  console.log(chalk.bold("\n  Qwenodyssey — live voice + vision  (continuous)\n"));
  console.log(chalk.gray("  brain   : ") + `${s.provider.model} (${s.provider.name})`);
  console.log(chalk.gray("  hearing : ") + `whisper-stream · ${model.split(/[\\/]/).pop()} (local, VAD ${cfg.audio.vad_threshold})`);
  console.log(chalk.gray("  vision  : ") + (cam ? `${cam} → ${cfg.vision.model} (${cfg.vision.provider})` : chalk.yellow("none")));
  console.log(chalk.gray("  voice   : ") + (tts.ok ? tts.detail : chalk.yellow(`off (${tts.detail})`)));
  console.log(
    "\n  " + chalk.gray("Just talk. ") +
      chalk.cyan("c") + chalk.gray(" toggle camera · ") +
      chalk.cyan("m") + chalk.gray(" mute/unmute mic · ") +
      chalk.cyan("q") + chalk.gray(" quit\n")
  );

  const history: Message[] = [{ role: "system", content: LIVE_SYSTEM }];
  let cameraOn = cfg.vision.enabled && !!cam;
  let busy = false; // responding/speaking — ignore input to avoid hearing our own voice
  let muted = false;
  let mutedUntil = 0; // brief cooldown after speaking

  // ── Continuous listener: whisper-stream in VAD segment mode (--step 0). ──
  if (!cfg.audio.enabled) {
    console.log(chalk.red("  [audio] is disabled — nothing to listen with.\n"));
    return;
  }
  const ws = execa(
    whisperStream,
    ["-m", model, "-l", cfg.audio.language, "--step", "0", "--length", "30000", "-vth", String(cfg.audio.vad_threshold)],
    { buffer: false, reject: false }
  );
  ws.catch(() => {});
  if (!ws.stdout) {
    console.log(chalk.red("  failed to start whisper-stream.\n"));
    return;
  }

  const respond = async (userText: string): Promise<void> => {
    busy = true;
    try {
      console.log(chalk.gray("  you said: ") + userText);
      let content = userText;
      if (cameraOn && cam) {
        try {
          const frame = await captureFrame(cam, ffmpeg);
          const desc = await describeImage(frame, userText, cfg);
          if (desc) {
            console.log(chalk.gray("  👁  " + desc.replace(/\s+/g, " ").slice(0, 180)));
            content = `[Camera view: ${desc}]\n\n${userText}`;
          }
        } catch (e) {
          console.log(chalk.yellow(`  (vision skipped: ${(e as Error).message})`));
        }
      }
      history.push({ role: "user", content });
      const spinner = new Spinner(thinkingWord(), 0);
      spinner.begin();
      let answer = "";
      try {
        const res = await s.provider.generate(history, { temperature: 0.5, max_tokens: cfg.model.max_tokens });
        answer = (res.text || "").trim();
      } finally {
        spinner.stop();
      }
      console.log(chalk.green("  model › ") + (answer || "(no response)") + "\n");
      history.push({ role: "assistant", content: answer });
      if (answer && tts.ok) await speak(answer, cfg);
    } catch (e) {
      console.log(chalk.red(`  [error: ${(e as Error).message}]\n`));
    } finally {
      mutedUntil = Date.now() + 1200; // ignore the tail of our own speech
      busy = false;
    }
  };

  const rlOut = readline.createInterface({ input: ws.stdout });
  let capturing = false;
  let segBuf = "";
  const handle = (utterance: string) => {
    const text = extractSpeech(utterance);
    if (!text) return;
    if (muted || busy || Date.now() < mutedUntil) return; // don't hear our own voice
    void respond(text);
  };
  rlOut.on("line", (raw) => {
    const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
    if (RE_START.test(line)) {
      capturing = true;
      segBuf = "";
      return;
    }
    if (RE_END.test(line)) {
      capturing = false;
      const seg = segBuf;
      segBuf = "";
      return handle(seg);
    }
    if (capturing) {
      segBuf += " " + line;
      return;
    }
    // Some builds print text inline without END markers — handle stray lines too.
    if (line && !line.startsWith("###")) handle(line);
  });

  // ── Control keys on our own stdin (whisper-stream captures audio via SDL, not stdin). ──
  await new Promise<void>((resolve) => {
    const stdin = process.stdin;
    const tty = !!stdin.isTTY;
    if (tty) {
      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
    }
    const cleanup = () => {
      try {
        if (tty) stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
      stdin.removeListener("keypress", onKey);
      rlOut.close();
      try {
        ws.kill();
      } catch {
        /* ignore */
      }
      resolve();
    };
    const onKey = (_str: string | undefined, key: readline.Key) => {
      if (!key) return;
      if (key.name === "q" || (key.ctrl && key.name === "c")) {
        console.log(chalk.gray("\n  ending live session…\n"));
        return cleanup();
      }
      if (key.name === "c") {
        if (!cam) return console.log(chalk.yellow("  (no camera)\n"));
        cameraOn = !cameraOn;
        console.log(chalk.gray(`  camera ${cameraOn ? "ON" : "off"}`));
      }
      if (key.name === "m") {
        muted = !muted;
        console.log(chalk.gray(`  mic ${muted ? "MUTED" : "live"}`));
      }
    };
    if (tty) stdin.on("keypress", onKey);
    ws.on("exit", () => cleanup());
  });
}
