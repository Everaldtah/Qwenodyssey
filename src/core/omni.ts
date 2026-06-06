/**
 * Omni call: send any combination of text + audio + image to a single multimodal
 * model (NVIDIA NIM / OpenAI-compatible) and get a reply. This is the "brain does
 * everything" path — the model ingests the raw mic audio and camera frame itself,
 * instead of local whisper + a separate vision model.
 *
 * Uses the OpenAI multimodal content format:
 *   content: [ {type:"text"}, {type:"input_audio", input_audio:{data,format}},
 *              {type:"image_url", image_url:{url}} ]
 */
import * as fs from "fs";
import type { Config } from "./config";
import { resolveNvidiaKey } from "../providers";

export interface OmniInput {
  model: string;
  text: string;
  audioPath?: string;
  audioFormat?: string; // "wav" | "mp3" | ...
  imagePath?: string;
  maxTokens?: number;
  temperature?: number;
}

function apiBase(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  return b.endsWith("/v1") ? b : b + "/v1";
}

export async function askOmni(input: OmniInput, config: Config): Promise<string> {
  const provider = config.omni.provider;
  const baseUrl =
    provider === "nvidia"
      ? config.nvidia.base_url || "https://integrate.api.nvidia.com"
      : config.model.base_url || "https://api.openai.com";
  const apiKey =
    provider === "nvidia" ? resolveNvidiaKey(config) : config.model.api_key || process.env.QWENODYSSEY_API_KEY || "";

  const content: any[] = [];
  if (input.text) content.push({ type: "text", text: input.text });
  if (input.audioPath) {
    content.push({
      type: "input_audio",
      input_audio: { data: fs.readFileSync(input.audioPath).toString("base64"), format: input.audioFormat || "wav" },
    });
  }
  if (input.imagePath) {
    const ext = /\.png$/i.test(input.imagePath) ? "png" : "jpeg";
    content.push({
      type: "image_url",
      image_url: { url: `data:image/${ext};base64,${fs.readFileSync(input.imagePath).toString("base64")}` },
    });
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${apiBase(baseUrl)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: input.model,
      messages: [{ role: "user", content }],
      max_tokens: input.maxTokens ?? 512,
      temperature: input.temperature ?? 0.3,
    }),
  });
  if (!res.ok) {
    throw new Error(`omni (${provider}) HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json: any = await res.json();
  return (json?.choices?.[0]?.message?.content ?? "").trim();
}
