/**
 * Continuous microphone VAD: one ffmpeg process streams raw 16kHz mono PCM, and
 * Node detects speech segments (voice-activity detection) frame-by-frame. Each
 * completed utterance is written to a WAV and handed back — no push-to-talk, and
 * a single mic reader (so it never fights a second capture). Also reports a live
 * loudness level for a VU/speaking indicator.
 */
import execa from "execa";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveFfmpeg } from "./media";

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS) / 1000 * 2; // 16-bit mono → 640 bytes

export interface MicVadHandlers {
  onLevel?: (db: number) => void; // ~50×/sec loudness for a meter
  onSpeechStart?: () => void;
  onUtterance: (wavPath: string) => void; // a finished speech segment
  onError?: (err: Error) => void;
}

export interface MicVadOptions {
  speakDb?: number; // dB above which a frame counts as speech (default -38)
  hangoverMs?: number; // trailing silence that ends an utterance (default 700)
  minUtteranceMs?: number; // ignore blips shorter than this (default 300)
  maxUtteranceMs?: number; // force-flush a very long utterance (default 30000)
  prerollMs?: number; // audio kept before speech onset (default 200)
}

export interface MicVad {
  pause(): void; // drop audio (e.g. while the assistant is speaking)
  resume(): void;
  stop(): void;
}

function frameDb(buf: Buffer): number {
  let sum = 0;
  const n = buf.length / 2;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const s = buf.readInt16LE(i);
    sum += s * s;
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  return rms > 0 ? 20 * Math.log10(rms / 32768) : -90;
}

function writeWav(pcm: Buffer): string {
  const out = path.join(os.tmpdir(), "qwenodyssey-media", `utt-${Date.now()}.wav`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(out, Buffer.concat([header, pcm]));
  return out;
}

export function startMicVad(
  device: string,
  handlers: MicVadHandlers,
  options: MicVadOptions = {},
  ffmpeg = resolveFfmpeg()
): MicVad {
  const speakDb = options.speakDb ?? -38;
  const hangover = options.hangoverMs ?? 700;
  const minUtt = options.minUtteranceMs ?? 300;
  const maxUtt = options.maxUtteranceMs ?? 30000;
  const preFrames = Math.round((options.prerollMs ?? 200) / FRAME_MS);

  const sub = execa(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-f", "dshow", "-i", `audio=${device}`, "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "-"],
    { reject: false, buffer: false }
  );
  sub.catch(() => {});
  if (sub.stderr) sub.stderr.on("data", (d) => handlers.onError?.(new Error(String(d).slice(0, 200))));

  let leftover: Buffer = Buffer.alloc(0);
  let speaking = false;
  let paused = false;
  let silenceMs = 0;
  let uttMs = 0;
  const preroll: Buffer[] = [];
  let utt: Buffer[] = [];

  const endUtterance = () => {
    const had = speaking;
    speaking = false;
    const frames = utt;
    utt = [];
    silenceMs = 0;
    const ms = uttMs;
    uttMs = 0;
    if (had && ms >= minUtt) handlers.onUtterance(writeWav(Buffer.concat(frames)));
  };

  const processFrame = (frame: Buffer) => {
    const db = frameDb(frame);
    handlers.onLevel?.(db);
    if (paused) return;

    // Maintain a short pre-roll ring buffer so we don't clip the first syllable.
    preroll.push(frame);
    if (preroll.length > preFrames) preroll.shift();

    if (db > speakDb) {
      if (!speaking) {
        speaking = true;
        uttMs = 0;
        utt = preroll.slice(0, -1); // include audio just before onset
        handlers.onSpeechStart?.();
      }
      utt.push(frame);
      uttMs += FRAME_MS;
      silenceMs = 0;
      if (uttMs >= maxUtt) endUtterance();
    } else if (speaking) {
      utt.push(frame);
      uttMs += FRAME_MS;
      silenceMs += FRAME_MS;
      if (silenceMs >= hangover) endUtterance();
    }
  };

  sub.stdout?.on("data", (chunk: Buffer) => {
    leftover = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    let off = 0;
    while (leftover.length - off >= FRAME_BYTES) {
      processFrame(leftover.subarray(off, off + FRAME_BYTES));
      off += FRAME_BYTES;
    }
    leftover = off ? leftover.subarray(off) : leftover;
  });

  return {
    pause() {
      paused = true;
      speaking = false;
      utt = [];
      uttMs = 0;
      silenceMs = 0;
    },
    resume() {
      paused = false;
    },
    stop() {
      try {
        sub.kill();
      } catch {
        /* ignore */
      }
    },
  };
}
