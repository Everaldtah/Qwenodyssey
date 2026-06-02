import { OpenAICompatibleProvider } from "./base";

/** LM Studio's local server is OpenAI-compatible (default http://localhost:1234). */
export class LMStudioProvider extends OpenAICompatibleProvider {
  readonly name = "lmstudio";
}
