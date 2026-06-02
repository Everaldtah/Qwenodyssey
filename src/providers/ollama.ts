import { OpenAICompatibleProvider } from "./base";
import type { ModelInfo } from "../types";

/** Ollama serves an OpenAI-compatible API at {base}/v1 and native at {base}/api. */
export class OllamaProvider extends OpenAICompatibleProvider {
  readonly name = "ollama";

  private root(): string {
    return this.cfg.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  }

  /** Use Ollama's native /api/tags so we get sizes alongside names. */
  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.root()}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: any = await res.json();
    return (json?.models ?? [])
      .map((m: any) => ({ name: m.name as string, size: formatBytes(m.size) }))
      .filter((m: ModelInfo) => m.name)
      .sort((a: ModelInfo, b: ModelInfo) => a.name.localeCompare(b.name));
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const root = this.root();
    try {
      const res = await fetch(`${root}/api/tags`);
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      const json: any = await res.json();
      const names = (json?.models ?? []).map((m: any) => m.name).join(", ");
      const has = names.includes(this.cfg.model);
      return {
        ok: true,
        detail: has
          ? undefined
          : `reachable, but "${this.cfg.model}" is not pulled (have: ${names || "none"})`,
      };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}

function formatBytes(bytes?: number): string | undefined {
  if (!bytes || bytes <= 0) return undefined;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
