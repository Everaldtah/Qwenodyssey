# Architecture

Qwenodyssey is a pipeline of small, single-purpose agents coordinated by an
orchestrator, over a uniform provider + tool layer.

## Pipeline

```
User Task
  → Intent (mode selection)
  → Repo Scanner      (language, framework, package manager, test cmd)
  → Planner Agent     (decompose into 2–6 steps, name files)
  → Context Builder   (token-budgeted, priority-ordered packing)
  → Coder Agent       (produce minimal patches as JSON)
  → Patch Engine      (apply unified diffs, journal for rollback)
  → Reviewer Agent    (correctness / security / style)
  → Test Runner       (detected test command)
  → Error-Fix Agent   (diagnose failures, patch, retry)
  → Summary
```

State transitions are tracked by `core/stateMachine.ts` and every stage emits a
JSONL event to the session log.

## Modules

| Path | Responsibility | Status |
|------|----------------|--------|
| `providers/` | Model backends (OpenAI-compatible base + Ollama/LMStudio/vLLM/llama.cpp) | ✅ working |
| `core/config.ts` | TOML config load/save + validation (zod) | ✅ |
| `core/repoScanner.ts` | Language/framework/test detection | ✅ |
| `core/contextBuilder.ts` | Token-budget context packing | ✅ |
| `core/patchEngine.ts` | Apply/rollback unified diffs, journal | ✅ |
| `core/orchestrator.ts` | Pipeline driver + modes | ✅ |
| `agents/*` | planner, coder, reviewer, tester, errorFixer, memory | ✅ |
| `tools/*` | file, shell (safety), git, search + registry | ✅ |
| `cli/*` | commander entry + commands + rendering | ✅ |

## Status & TODO

The foundation is functional end-to-end against Ollama. Deeper items on the
[roadmap](../README.md#roadmap) are intentionally stubbed or simple:

- Context relevance is heuristic (filename + git diff). Tree-sitter symbol
  extraction and embeddings-based retrieval are planned.
- Memory is keyword search over markdown; vector memory is planned.
- `sandbox` currently means cwd-scoping + blocklist + timeout, not a true OS
  sandbox. Container/jail execution is planned.
