import { OpenAICompatibleProvider } from "./base";

/** Generic OpenAI-compatible endpoint (OpenAI itself, OpenRouter, Groq, etc.). */
export class OpenAICompatibleEndpointProvider extends OpenAICompatibleProvider {
  readonly name = "openai";
}
