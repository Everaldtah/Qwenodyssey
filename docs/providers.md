# Providers

All providers implement one interface (`src/types.ts → Provider`):

```ts
generate(messages, options): Promise<GenerateResult>
stream(messages, onChunk, options): Promise<GenerateResult>
countTokens(text): number
healthCheck(): Promise<{ ok: boolean; detail?: string }>
```

Because Ollama, LM Studio, vLLM, and llama.cpp all expose an OpenAI-compatible
`/v1/chat/completions` endpoint, they share `OpenAICompatibleProvider`
(`src/providers/base.ts`). Concrete classes only override defaults and health
checks.

| Provider | Default base URL | Notes |
|----------|------------------|-------|
| `ollama` | `http://localhost:11434` | Health check uses `/api/tags`; warns if model isn't pulled |
| `lmstudio` | `http://localhost:1234` | Start the LM Studio local server first |
| `openai` | `https://api.openai.com` | Needs `model.api_key` or `QWENODYSSEY_API_KEY` |
| `vllm` | `http://localhost:8000` | `--api-key` optional |
| `llamacpp` | `http://localhost:8080` | `./server -m model.gguf` |

## Adding a provider

1. Create `src/providers/yours.ts` extending `OpenAICompatibleProvider`.
2. Register it in `src/providers/index.ts` and the `provider` enum in
   `src/core/config.ts`.
3. Override `healthCheck()` if it isn't a standard `/v1/models` probe.
