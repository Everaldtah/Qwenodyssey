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
  /** Full model path ("publisher/Repo-GGUF/file.gguf") — what `lms load --exact` wants. */
  path?: string;
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
  /**
   * Context window to load SMALL models with (the harness's configured
   * model.context_tokens). LM Studio's default is 4096, which is smaller than
   * the agent's system prompt + tool schemas — every tool turn then fails with
   * "n_keep >= n_ctx". Omitted/0 = leave LM Studio's default.
   */
  contextTokens?: number;
  /** Reload even if the model is already loaded (e.g. after a context overflow). */
  force?: boolean;
}

export interface LoadedModel {
  identifier: string;
  modelKey: string;
  contextLength: number;
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

/** GPU memory snapshot (GB) from nvidia-smi; null when no NVIDIA GPU/tool is present. */
export interface GpuMem {
  totalGB: number;
  freeGB: number;
}

export class LmStudioControl {
  readonly bin: string;
  private gpuMemCache: { at: number; mem: GpuMem | null } | null = null;
  constructor(binPath?: string) {
    this.bin = lmsBin(binPath);
  }

  /**
   * Best-effort GPU memory probe (nvidia-smi), cached for 10s. Used to decide
   * whether a model that is "small" by parameter count still won't fit next to
   * whatever else is using the card (e.g. a 6.5 GB 9B model on a 6 GB RTX 3050
   * with 2.8 GB already taken by other apps).
   */
  async gpuMem(): Promise<GpuMem | null> {
    if (this.gpuMemCache && Date.now() - this.gpuMemCache.at < 10_000) return this.gpuMemCache.mem;
    let mem: GpuMem | null = null;
    try {
      const r = await execa(
        "nvidia-smi",
        ["--query-gpu=memory.total,memory.used", "--format=csv,noheader,nounits"],
        { reject: false, timeout: 5_000 }
      );
      const line = (r.stdout || "").trim().split(/\r?\n/)[0] || "";
      const [total, used] = line.split(",").map((x) => Number(x.trim()));
      if (r.exitCode === 0 && total > 0 && used >= 0) {
        mem = { totalGB: total / 1024, freeGB: Math.max(0, total - used) / 1024 };
      }
    } catch {
      /* no nvidia-smi — fall back to the configured size thresholds */
    }
    this.gpuMemCache = { at: Date.now(), mem };
    return mem;
  }

  /**
   * Is this model "big" for THIS machine: over the configured thresholds, or
   * larger than the GPU memory currently free (so it would spill to CPU anyway)?
   */
  isBig(model: LmsModel, opts: SafeLoadOpts, gpu: GpuMem | null): boolean {
    if (model.paramsB >= opts.bigParamsB || model.sizeGB >= opts.bigSizeGB) return true;
    return !!gpu && model.sizeGB > gpu.freeGB * 0.9;
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
        path: (m.path || m.indexedModelIdentifier || undefined) as string | undefined,
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
    return (await this.loadedDetail()).map((m) => m.identifier || m.modelKey).filter(Boolean);
  }

  /** Loaded models with the context length each was loaded with (`lms ps --json`). */
  async loadedDetail(): Promise<LoadedModel[]> {
    const r = await this.run(["ps", "--json"], 20_000);
    try {
      const arr = JSON.parse(r.stdout || "[]");
      return arr.map((m: any) => ({
        identifier: String(m.identifier || m.modelKey || ""),
        modelKey: String(m.modelKey || m.identifier || ""),
        contextLength: Number(m.contextLength) || 0,
      }));
    } catch {
      return [];
    }
  }

  /** Context length a model should be loaded with under these options. */
  contextFor(model: LmsModel, opts: SafeLoadOpts, gpu: GpuMem | null = null): number {
    const big = this.isBig(model, opts, gpu);
    const want = big ? opts.bigContext : opts.contextTokens || 0;
    if (!want) return 0;
    return model.maxContext ? Math.min(want, model.maxContext) : want;
  }

  /**
   * Ensure the local server is up. Fast path: an HTTP probe (≈100ms) — if it
   * already answers (200 or 401 "needs key"), skip the slow `lms server start`
   * (which spawns the CLI and can take ~10s). Only starts it when truly down.
   */
  async ensureServer(port = 1234, bind = "0.0.0.0", baseUrl?: string): Promise<boolean> {
    const root = (baseUrl || `http://localhost:${port}`).replace(/\/+$/, "").replace(/\/v1$/, "");
    try {
      const res = await fetch(`${root}/v1/models`, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200 || res.status === 401) return true; // already running
    } catch {
      /* not up — start it below */
    }
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
  async safeLoad(
    model: LmsModel,
    opts: SafeLoadOpts
  ): Promise<{ ok: boolean; detail: string; big: boolean; reloaded: boolean; skipped: boolean }> {
    const gpu = await this.gpuMem();
    const big = this.isBig(model, opts, gpu);
    const ctx = this.contextFor(model, opts, gpu);

    // Already loaded? `lms load` refuses a duplicate identifier, so decide here:
    // keep it when its context is big enough, otherwise unload and reload.
    let reloaded = false;
    const current = (await this.loadedDetail()).find(
      (m) => m.identifier === model.key || m.modelKey === model.key
    );
    if (current) {
      const enough = !ctx || current.contextLength >= ctx;
      if (enough && !opts.force) return { ok: true, detail: "already loaded", big, reloaded, skipped: true };
      await this.unload(current.identifier || model.key);
      reloaded = true;
    }

    const extra: string[] = ["--yes", "--identifier", model.key];
    if (ctx) extra.push("-c", String(ctx));
    if (big) {
      extra.push("--ttl", String(opts.ttlSeconds));
      // Partial GPU offload so the overflow lands on system RAM rather than
      // OOM-ing the GPU: sized from the memory actually free when we know it
      // (leave ~25% of it for the KV cache), else the old fixed rule.
      if (gpu && model.sizeGB > gpu.freeGB * 0.9) {
        const ratio = Math.min(0.9, Math.max(0.1, (gpu.freeGB * 0.75) / model.sizeGB));
        extra.push("--gpu", ratio.toFixed(2));
      } else if (model.sizeGB >= 18) extra.push("--gpu", "0.5");
    }
    // Prefer an exact match on the full path: the short key "qwen3.5-0.8b" would
    // otherwise fuzzy-match "qwen3.5-0.8b-toolcalling" too ("2 models match…").
    // Fall back to the key if the path form is rejected by an older CLI.
    let r = model.path
      ? await this.run(["load", model.path, "--exact", ...extra], 600_000)
      : { exitCode: 1, all: "" };
    if (r.exitCode !== 0) r = await this.run(["load", model.key, ...extra], 600_000);
    return { ok: r.exitCode === 0, detail: (r.all || "").trim(), big, reloaded, skipped: false };
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
