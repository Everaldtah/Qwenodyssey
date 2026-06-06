/**
 * `qwenodyssey mictest` — record your voice and verify two things at once:
 *   1. local speech-to-text (whisper.cpp) transcribes it, and
 *   2. the omni model (e.g. phi-4-multimodal) accepts the raw audio and replies.
 *
 * Interactive push-to-talk so we can test together: press Enter, speak, Enter to
 * stop. Optionally attaches a camera frame to confirm audio+vision in one call.
 */
import * as readline from "readline";
import chalk from "chalk";
import { createSession, GlobalOpts } from "../session";
import {
  resolveFfmpeg,
  resolveWhisperBin,
  defaultWhisperModel,
  pickAudioDevice,
  pickVideoDevice,
  startRecording,
  transcribe,
  captureFrame,
} from "../../core/media";
import { askOmni } from "../../core/omni";

export async function mictestCommand(opts: GlobalOpts): Promise<void> {
  const s = createSession(opts);
  const cfg = s.config;
  const ffmpeg = resolveFfmpeg();

  const cam = cfg.vision.enabled ? await pickVideoDevice(cfg.vision.device, ffmpeg).catch(() => null) : null;
  const mic = await pickAudioDevice(cfg.audio.device, cam, ffmpeg).catch(() => null);
  const whisperBin = resolveWhisperBin(cfg.audio.whisper_bin);
  const whisperModel = cfg.audio.whisper_model || defaultWhisperModel();
  const omniModel = cfg.omni.model;

  console.log(chalk.bold("\n  Qwenodyssey — microphone + omni test\n"));
  console.log(chalk.gray("  mic        : ") + (mic ? mic : chalk.red("none detected")));
  console.log(chalk.gray("  whisper    : ") + `${whisperBin} · ${whisperModel.split(/[\\/]/).pop()}`);
  console.log(chalk.gray("  omni model : ") + `${omniModel} (${cfg.omni.provider})`);
  console.log(chalk.gray("  camera     : ") + (cam ? cam : "none") + "\n");

  if (!mic) {
    console.log(chalk.red("  No microphone found via DirectShow. Set audio.device or check Windows mic privacy.\n"));
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  for (;;) {
    const go = (await ask(chalk.cyan("\n  Press Enter to record (type q to quit): "))).trim().toLowerCase();
    if (go === "q" || go === "quit") break;

    console.log(chalk.magenta("  ● recording…") + chalk.gray("  speak now, then press Enter to stop"));
    const rec = startRecording(mic, cfg.audio.max_seconds, ffmpeg);
    await ask("");
    let wav: string;
    try {
      wav = await rec.stop();
    } catch (e) {
      console.log(chalk.red(`  recording failed: ${(e as Error).message}`));
      continue;
    }

    // 1) Local whisper transcription.
    try {
      process.stdout.write(chalk.gray("  transcribing locally… "));
      const text = await transcribe(wav, { bin: whisperBin, model: whisperModel, language: cfg.audio.language });
      process.stdout.write("\r\x1b[2K");
      console.log(chalk.gray("  whisper heard : ") + (text ? chalk.white(text) : chalk.yellow("(nothing)")));
    } catch (e) {
      process.stdout.write("\r\x1b[2K");
      console.log(chalk.red(`  whisper failed: ${(e as Error).message}`));
    }

    // 2) Omni model — send the raw audio (and optionally a camera frame).
    let imagePath: string | undefined;
    if (cam && cfg.omni.send_image) {
      try {
        imagePath = await captureFrame(cam, ffmpeg);
        console.log(chalk.gray("  (attached a camera frame)"));
      } catch (e) {
        console.log(chalk.yellow(`  (no camera frame: ${(e as Error).message})`));
      }
    }
    try {
      process.stdout.write(chalk.gray(`  asking ${omniModel}… `));
      const reply = await askOmni(
        {
          model: omniModel,
          text:
            "The user spoke to you (audio attached" +
            (imagePath ? " along with their camera view" : "") +
            "). First repeat what you heard, then respond.",
          audioPath: wav,
          imagePath,
        },
        cfg
      );
      process.stdout.write("\r\x1b[2K");
      console.log(chalk.green("  omni reply    : ") + (reply || chalk.yellow("(empty)")));
    } catch (e) {
      process.stdout.write("\r\x1b[2K");
      console.log(chalk.red(`  omni failed   : ${(e as Error).message}`));
      console.log(chalk.gray("  → if this is an audio-format error, this model can't take audio input on NIM."));
    }
  }

  rl.close();
  console.log(chalk.gray("\n  mic test ended.\n"));
}
