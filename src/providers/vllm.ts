import { OpenAICompatibleProvider } from "./base";

/** vLLM's OpenAI server (default http://localhost:8000). */
export class VLLMProvider extends OpenAICompatibleProvider {
  readonly name = "vllm";
}
