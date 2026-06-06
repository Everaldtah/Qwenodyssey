/**
 * Text-to-speech for spoken replies. Default engine is Piper (local neural TTS):
 * pipe text → WAV → play with ffplay. Falls back to the built-in Windows SAPI
 * voice, or no speech. Fully local either way.
 */
import execa from "execa";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Config } from "./config";

function piperBin(explicit: string): string {
  if (explicit) return explicit;
  return path.join(os.homedir(), ".qwenodyssey", "piper", "piper", "piper.exe");
}
function piperVoice(explicit: string): string {
  if (explicit) return explicit;
  return path.join(os.homedir(), ".qwenodyssey", "piper", "voices", "en_US-amy-medium.onnx");
}
function ffplay(): string {
  const shim = path.join(os.homedir(), "scoop", "shims", "ffplay.exe");
  return fs.existsSync(shim) ? shim : "ffplay";
}

/** Is speech actually available for the configured engine? */
export function ttsAvailable(config: Config): { ok: boolean; detail: string } {
  const t = config.tts;
  if (!t.enabled || t.engine === "none") return { ok: false, detail: "disabled" };
  if (t.engine === "sapi") return { ok: true, detail: "Windows SAPI" };
  const bin = piperBin(t.piper_bin);
  const voice = piperVoice(t.piper_voice);
  if (!fs.existsSync(bin)) return { ok: false, detail: `piper not found at ${bin}` };
  if (!fs.existsSync(voice)) return { ok: false, detail: `voice not found at ${voice}` };
  return { ok: true, detail: `piper · ${path.basename(voice)}` };
}

/** Speak `text` aloud, resolving once playback finishes. Best-effort: never throws. */
export async function speak(text: string, config: Config): Promise<void> {
  const t = config.tts;
  const clean = (text || "").replace(/```[\s\S]*?```/g, " (code block) ").replace(/\s+/g, " ").trim();
  if (!clean || !t.enabled || t.engine === "none") return;

  try {
    if (t.engine === "sapi") {
      // Synchronous SAPI speak in a child PowerShell process.
      await execa(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Add-Type -AssemblyName System.Speech; " +
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
            "$s.Speak([Console]::In.ReadToEnd())",
        ],
        { input: clean, reject: false, timeout: 120000 }
      );
      return;
    }

    // Piper → WAV → ffplay.
    const bin = piperBin(t.piper_bin);
    const voice = piperVoice(t.piper_voice);
    if (!fs.existsSync(bin) || !fs.existsSync(voice)) return;
    const wav = path.join(os.tmpdir(), `qwenodyssey-tts-${Date.now()}.wav`);
    await execa(bin, ["-m", voice, "-f", wav], { input: clean, reject: false, timeout: 120000 });
    if (fs.existsSync(wav)) {
      await execa(ffplay(), ["-nodisp", "-autoexit", "-loglevel", "quiet", wav], {
        reject: false,
        timeout: 120000,
      });
      try {
        fs.unlinkSync(wav);
      } catch {
        /* temp cleanup best-effort */
      }
    }
  } catch {
    /* speech is non-essential — never break the conversation over it */
  }
}
