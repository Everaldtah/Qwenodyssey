# Optimizing for Qwen 2.5 7B

Qwenodyssey's whole reason to exist is making a small model punch above its
weight. The techniques:

### 1. Explicit planning
Before any code, the planner decomposes the task into 2–6 concrete steps and
names the files involved. Small models do far better executing a short, concrete
plan than improvising a large change.

### 2. Constrained context packing
`contextBuilder.ts` enforces a token budget (default 60% of `model.context_tokens`)
and fills it by priority:

1. User request 2. Relevant files 3. Errors 4. Repo structure 5. Git diff 6. Memory

Files are clipped (head + tail) so one huge file can't crowd out everything else.

### 3. Patch-based edits
The coder is asked for **unified diffs**, not whole-file rewrites. This keeps
output short (less chance to hallucinate), preserves surrounding code, and makes
review/rollback trivial.

### 4. Structured JSON I/O
Planner, coder, reviewer, and error-fixer all return strict JSON. `core/parse.ts`
tolerantly extracts JSON even when the model wraps it in prose or fences or adds
trailing commas.

### 5. Self-review
A separate reviewer pass catches missing imports, undefined symbols, and obvious
bugs *before* edits are applied.

### 6. Real test feedback + bounded retries
The tester runs the project's actual test command. On failure, the error-fixer
gets the real output and proposes a targeted patch, up to `agent.max_retries`.

### 7. Small-model-friendly prompts
Prompts (`src/prompts/*.md`) are terse and directive: short steps, no vague
reasoning, cite files, state assumptions, never invent APIs.

### Recommended settings (6–8 GB VRAM)

```toml
[model]
model = "qwen2.5-coder:7b"
temperature = 0.2
context_tokens = 8192   # keep modest so the KV cache fits

[agent]
small_model_mode = true
max_retries = 4
```
