import { OpenAICompatibleProvider } from "./base";

/** Ollama serves an OpenAI-compatible API at {base}/v1 and native at {base}/api. */
export class OllamaProvider extends OpenAICompatibleProvider {
  readonly name = "ollama";

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const root = this.cfg.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
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
