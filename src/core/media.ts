/**
 * Webcam + microphone capture for live voice/vision, built on ffmpeg (DirectShow
 * on Windows) and a local whisper.cpp binary for speech-to-text. Everything here
 * is local: frames/audio are written to a temp dir; only the captured *frame* is
 * later sent to a vision model (see core/vision.ts), and transcription stays
 * on-device.
 */
import execa from "execa";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface DshowDevices {
  video: string[];
  audio: string[];
}

/** Locate the ffmpeg binary: PATH first, then the scoop shim. */
export function resolveFfmpeg(): string {
  const home = os.homedir();
  const candidates = [
    path.join(home, "scoop", "shims", "ffmpeg.exe"),
    path.join(home, "scoop", "shims", "ffmpeg"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "ffmpeg"; // assume on PATH
}

/**
 * Locate the whisper.cpp CLI. Honors an explicit path, else searches the scoop
 * shims and PATH for the known binary names (newer builds renamed main → whisper-cli).
 */
export function resolveWhisperBin(explicit?: string): string {
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (explicit) return explicit; // trust an explicit name on PATH
  const home = os.homedir();
  const names = ["whisper-cli", "whisper-cpp", "whisper", "main"];
  for (const n of names) {
    for (const ext of [".exe", ".cmd", ""]) {
      const p = path.join(home, "scoop", "shims", n + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return "whisper-cli"; // last resort: assume on PATH
}

/** Locate the whisper.cpp streaming binary (continuous mic transcription). */
export function resolveWhisperStream(): string {
  const home = os.homedir();
  for (const ext of [".exe", ".cmd", ""]) {
    const p = path.join(home, "scoop", "shims", "whisper-stream" + ext);
    if (fs.existsSync(p)) return p;
  }
  return "whisper-stream";
}

/** Default whisper model path under the user's Qwenodyssey home. */
export function defaultWhisperModel(): string {
  return path.join(os.homedir(), ".qwenodyssey", "models", "ggml-base.en.bin");
}

/** Temp dir for capture artifacts. */
function captureDir(): string {
  const d = path.join(os.tmpdir(), "qwenodyssey-media");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Enumerate DirectShow video + audio devices (Windows). Listing does NOT activate
 * the camera/mic — ffmpeg just queries the device graph and exits.
 */
export async function listDshowDevices(ffmpeg = resolveFfmpeg()): Promise<DshowDevices> {
  const res = await execa(
    ffmpeg,
    ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    { reject: false, all: true }
  );
  const out = (res.all || res.stderr || "") as string;
  const video: string[] = [];
  const audio: string[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/"([^"]+)"\s*\((video|audio)\)/i);
    if (!m) continue;
    if (m[2].toLowerCase() === "video") video.push(m[1]);
    else audio.push(m[1]);
  }
  return { video, audio };
}

/** Pick the camera device: configured name, else the first enumerated video device. */
export async function pickVideoDevice(configured: string, ffmpeg = resolveFfmpeg()): Promise<string | null> {
  if (configured) return configured;
  const { video } = await listDshowDevices(ffmpeg);
  return video[0] ?? null;
}

/**
 * Pick the mic: configured name, else prefer an audio device whose name references
 * the camera (e.g. "Microphone (NewEye 60s)"), else the first real mic that isn't
 * an obvious virtual/loopback device.
 */
export async function pickAudioDevice(
  configured: string,
  cameraName: string | null,
  ffmpeg = resolveFfmpeg()
): Promise<string | null> {
  if (configured) return configured;
  const { audio } = await listDshowDevices(ffmpeg);
  if (cameraName) {
    const token = cameraName.split(/\s+/)[0]?.toLowerCase();
    const match = audio.find((a) => token && a.toLowerCase().includes(token));
    if (match) return match;
  }
  const real = audio.find((a) => !/virtual|loopback|stereo mix|cable/i.test(a));
  return real ?? audio[0] ?? null;
}

/** Capture a single still frame from the camera to a JPEG. Returns the path. */
export async function captureFrame(device: string, ffmpeg = resolveFfmpeg()): Promise<string> {
  const out = path.join(captureDir(), `frame-${Date.now()}.jpg`);
  await execa(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "dshow", "-i", `video=${device}`, "-frames:v", "1", "-q:v", "2", out],
    { reject: true, timeout: 20000 }
  );
  if (!fs.existsSync(out)) throw new Error("camera capture produced no file");
  return out;
}

export interface Recording {
  /** Stop recording cleanly (sends 'q' to ffmpeg so the WAV is finalized). Resolves to the wav path. */
  stop(): Promise<string>;
}

/**
 * Start recording the mic to a 16kHz mono WAV (whisper's preferred format). Returns
 * a handle whose stop() finalizes the file. A maxSeconds cap auto-stops it.
 */
export function startRecording(device: string, maxSeconds: number, ffmpeg = resolveFfmpeg()): Recording {
  const out = path.join(captureDir(), `audio-${Date.now()}.wav`);
  const sub = execa(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "dshow", "-i", `audio=${device}`, "-ar", "16000", "-ac", "1", "-t", String(maxSeconds), out],
    { reject: false, stdin: "pipe" }
  );
  let settled: Promise<string> | null = null;
  const finish = () =>
    sub.then(() => {
      if (!fs.existsSync(out)) throw new Error("microphone capture produced no file");
      return out;
    });
  return {
    stop() {
      if (settled) return settled;
      try {
        sub.stdin?.write("q"); // ffmpeg: graceful stop, flush + close the WAV
      } catch {
        sub.kill("SIGINT");
      }
      settled = finish();
      return settled;
    },
  };
}

export interface LevelMeter {
  stop(): void;
}

/**
 * Stream live microphone loudness (RMS dB) from ffmpeg's astats filter. Calls
 * onLevel ~10×/sec with a value roughly in [-90, 0] dB (−90 ≈ silence). Used to
 * draw a VU meter so the user can see their mic is actually picking up sound.
 */
export function startLevelMeter(
  device: string,
  onLevel: (db: number) => void,
  ffmpeg = resolveFfmpeg()
): LevelMeter {
  const sub = execa(
    ffmpeg,
    [
      "-hide_banner",
      "-f",
      "dshow",
      "-i",
      `audio=${device}`,
      "-af",
      // ~0.1s windows → ~10 updates/sec, RMS level printed to stderr.
      "aresample=16000,asetnsamples=n=1600:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
      "-f",
      "null",
      "-",
    ],
    { reject: false, buffer: false }
  );
  sub.catch(() => {});
  const rl = sub.stderr ? readlineLines(sub.stderr) : null;
  rl?.on("line", (line: string) => {
    const m = line.match(/RMS_level=(-?inf|-?\d+(?:\.\d+)?)/i);
    if (!m) return;
    const db = /inf/i.test(m[1]) ? -90 : Number(m[1]);
    if (!Number.isNaN(db)) onLevel(db);
  });
  return {
    stop() {
      rl?.close();
      try {
        sub.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Tiny helper: line-reader over a stream without pulling in extra deps at call sites. */
function readlineLines(stream: NodeJS.ReadableStream) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const readline = require("readline") as typeof import("readline");
  return readline.createInterface({ input: stream });
}

/**
 * Transcribe a WAV with whisper.cpp. Writes a .txt next to a temp base and returns
 * the trimmed text. Throws if the binary/model is missing.
 */
export async function transcribe(
  wavPath: string,
  opts: { bin: string; model: string; language: string }
): Promise<string> {
  if (!fs.existsSync(opts.model)) {
    throw new Error(
      `whisper model not found at ${opts.model}. Download one, e.g. ggml-base.en.bin, or set audio.whisper_model.`
    );
  }
  const base = wavPath.replace(/\.wav$/i, "") + "-stt";
  await execa(
    opts.bin,
    ["-m", opts.model, "-f", wavPath, "-l", opts.language, "-nt", "-otxt", "-of", base],
    { reject: true, timeout: 120000 }
  );
  const txt = base + ".txt";
  const text = fs.existsSync(txt) ? fs.readFileSync(txt, "utf-8") : "";
  return text.replace(/\s+/g, " ").trim();
}
