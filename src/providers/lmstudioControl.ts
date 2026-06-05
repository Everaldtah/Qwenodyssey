/**
 * Headless control of LM Studio via its `lms` CLI — no need to open the app.
 *
 * The CLI talks to LM Studio's local core directly, so it works even when the
 * HTTP server requires an API key (listing/loading don't need the token; only
 * inference over /v1 does). We use it to: enumerate installed models, start the
 * server headless, estimate a model's memory cost, and SAFE-LOAD big models
 * (>~20B) with capped context + partial GPU offload so they don't OOM-crash the
 * machine. Inference itself still goes through the OpenAI-compatible /v1 server
 * (the LMStudioProvider).
 */
import execa from "execa";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

export interface LmsModel {
  key: string; // model key usable as the /v1 "model" id and `lms load` path
  displayName: string;
  paramsB: number; // billions of parameters (best-effort)
  paramsString: string;
  arch: string;
  sizeGB: number;
  maxContext: number;
  toolUse: boolean;
  vision: boolean;
}

export interface SafeLoadOpts {
  bigParamsB: number; // params threshold to treat a model as "big"
  bigSizeGB: number; // size threshold to treat a model as "big"
  bigContext: number; // capped context for big models
  ttlSeconds: number; // auto-unload idle big models
}

/** Resolve the lms CLI path (configured → default install → PATH). */
export function lmsBin(configured?: string): string {
  if (configured && fs.existsSync(configured)) return configured;
  const def = path.join(os.homedir(), ".lmstudio", "bin", "lms.exe");
  if (fs.existsSync(def)) return def;
  const nix = path.join(os.homedir(), ".lmstudio", "bin", "lms");
  if (fs.existsSync(nix)) return nix;
  return "lms"; // hope it's on PATH
}

export class LmStudioControl {
  readonly bin: string;
  constructor(binPath?: string) {
    this.bin = lmsBin(binPath);
  }

  /** Is the lms CLI actually present/usable? */
  installed(): boolean {
    return this.bin !== "lms" || hasOnPath("lms");
  }

  private async run(args: string[], timeout = 60_000) {
    return execa(this.bin, args, { reject: false, timeout, all: true });
  }

  /** All installed LLMs (embeddings excluded), parsed from `lms ls --json`. */
  async list(): Promise<LmsModel[]> {
    const r = await this.run(["ls", "--json"], 30_000);
    let arr: any[];
    try {
      arr = JSON.parse(r.stdout || "[]");
    } catch {
      return [];
    }
    return arr
      .filter((m) => m?.type === "llm" && m?.modelKey)
      .map((m) => ({
        key: m.modelKey as string,
        displayName: m.displayName || m.modelKey,
        paramsString: m.paramsString || "",
        paramsB: parseParams(m.paramsString),
        arch: m.architecture || "",
        sizeGB: (m.sizeBytes || 0) / 1e9,
        maxContext: m.maxContextLength || 0,
        toolUse: !!m.trainedForToolUse,
        vision: !!m.vision,
      }));
  }

  /** Identifiers of currently loaded models (`lms ps`). */
  async loaded(): Promise<string[]> {
    const r = await this.run(["ps", "--json"], 20_000);
    try {
      const arr = JSON.parse(r.stdout || "[]");
      return arr.map((m: any) => m.identifier || m.modelKey).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Start the local server headless (idempotent). */
  async ensureServer(port = 1234, bind = "0.0.0.0"): Promise<boolean> {
    const r = await this.run(["server", "start", "--port", String(port), "--bind", bind], 30_000);
    return r.exitCode === 0;
  }

  /** Estimated memory (GB) to load a model, without loading it. */
  async estimateGB(key: string): Promise<number | null> {
    const r = await this.run(["load", key, "--estimate-only", "--yes"], 60_000);
    const m = (r.all || "").match(/Estimated Total Memory:\s*([\d.]+)\s*GB/i);
    return m ? parseFloat(m[1]) : null;
  }

  /**
   * Load a model with crash-safe parameters. Big models (>= thresholds) get a
   * capped context and partial GPU offload (the rest runs on CPU/RAM) plus a
   * TTL, so they run slowly instead of exhausting VRAM/RAM and crashing the PC.
   * Smaller models load with LM Studio's automatic (optimal) settings.
   */
  async safeLoad(model: LmsModel, opts: SafeLoadOpts): Promise<{ ok: boolean; detail: string; big: boolean }> {
    const big = model.paramsB >= opts.bigParamsB || model.sizeGB >= opts.bigSizeGB;
    const args = ["load", model.key, "--yes", "--identifier", model.key];
    if (big) {
      const ctx = Math.min(opts.bigContext, model.maxContext || opts.bigContext);
      args.push("-c", String(ctx), "--ttl", String(opts.ttlSeconds));
      // Very large footprints: force partial GPU offload so the overflow lands
      // on system RAM rather than OOM-ing the GPU.
      if (model.sizeGB >= 18) args.push("--gpu", "0.5");
    }
    const r = await this.run(args, 600_000);
    return { ok: r.exitCode === 0, detail: (r.all || "").trim(), big };
  }

  async unload(key: string): Promise<void> {
    await this.run(["unload", key], 20_000);
  }
}

/** "35B-A3B" → 35, "7.5B" → 7.5, "64x2.6B" → 64*2.6, "20B" → 20. */
function parseParams(s: string): number {
  if (!s) return 0;
  const mult = s.match(/([\d.]+)\s*x\s*([\d.]+)\s*B/i);
  if (mult) return parseFloat(mult[1]) * parseFloat(mult[2]);
  const m = s.match(/([\d.]+)\s*B/i);
  return m ? parseFloat(m[1]) : 0;
}

function hasOnPath(cmd: string): boolean {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  return dirs.some((d) => exts.some((e) => d && fs.existsSync(path.join(d, cmd + e))));
}
