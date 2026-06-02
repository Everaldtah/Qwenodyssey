import { OpenAICompatibleProvider } from "./base";

/** llama.cpp server (default http://localhost:8080) exposes /v1/chat/completions. */
export class LlamaCppProvider extends OpenAICompatibleProvider {
  readonly name = "llamacpp";
}
