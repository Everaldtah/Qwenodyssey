/**
 * Vision: describe a captured image with a vision-language model. NVIDIA NIM and
 * other OpenAI-compatible endpoints take an `image_url` data URI; Ollama takes a
 * base64 `images` array. Returns the model's text description.
 */
import * as fs from "fs";
import type { Config } from "./config";
import { resolveNvidiaKey } from "../providers";

const DEFAULT_PROMPT =
  "Describe what you see in this webcam image concisely and concretely: people, objects, " +
  "text, gestures, and anything notable. If the user asked something specific, answer that.";

function dataUri(imagePath: string): string {
  const b64 = fs.readFileSync(imagePath).toString("base64");
  const ext = /\.png$/i.test(imagePath) ? "png" : "jpeg";
  return `data:image/${ext};base64,${b64}`;
}

function apiBase(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  return b.endsWith("/v1") ? b : b + "/v1";
}

export async function describeImage(
  imagePath: string,
  prompt: string,
  config: Config
): Promise<string> {
  const v = config.vision;
  const question = (prompt || "").trim() || DEFAULT_PROMPT;

  if (v.provider === "ollama") {
    const base = (config.model.base_url || "http://localhost:11434").replace(/\/+$/, "");
    const b64 = fs.readFileSync(imagePath).toString("base64");
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: v.model,
        messages: [{ role: "user", content: question, images: [b64] }],
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`vision (ollama) HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json: any = await res.json();
    return (json?.message?.content ?? "").trim();
  }

  // nvidia / openai-compatible: image_url data URI.
  const baseUrl =
    v.provider === "nvidia"
      ? config.nvidia.base_url || "https://integrate.api.nvidia.com"
      : config.model.base_url || "https://api.openai.com";
  const apiKey =
    v.provider === "nvidia"
      ? resolveNvidiaKey(config)
      : config.model.api_key || process.env.QWENODYSSEY_API_KEY || "";

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${apiBase(baseUrl)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: v.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "image_url", image_url: { url: dataUri(imagePath) } },
          ],
        },
      ],
      max_tokens: 1024,
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    throw new Error(`vision (${v.provider}) HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json: any = await res.json();
  return (json?.choices?.[0]?.message?.content ?? "").trim();
}
