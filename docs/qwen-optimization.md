# Optimizing for small local models (Qwen 3.5 9B and below)

Qwenodyssey's whole reason to exist is making a small model punch above its
weight. The techniques:

### 0. Model-aware decoding (auto)

The single biggest lever on a ≤9B model is how it's sampled, and the right
settings differ per family. `src/core/modelProfile.ts` classifies the active
model by name and applies the decoding its authors recommend — wherever you
haven't set a value yourself:

| family | thinking | temperature (turn floor) | top_p | top_k | penalties |
|---|---|---|---|---|---|
| `qwen3` / `qwen3.5` (hybrid) | off by default | 0.7 (floor **0.3**) | 0.8 | 20 | presence 1.5, repeat 1.05 |
| `qwen3` with `think = "always"` | on | 0.6 (floor 0.6) | 0.95 | 20 | repeat 1.05 |
| `qwen2.5` / `qwen2.5-coder` | n/a | 0.2 (floor **0**) | 0.8 | 20 | repeat 1.05 |
| `deepseek-r1`, `qwq` | always on | 0.6 (floor 0.6) | 0.95 | — | — |
| `gemma` | n/a | 0.2 (floor 0) | 0.95 | 64 | repeat 1.05 |
| anything else | n/a | your config | your config | — | — |

Why the floors differ: Qwen3/3.5 and the R1-class reasoners **degenerate into
repetition loops at temperature 0**, so tool turns get a small floor instead of
pure greedy decoding. Qwen2.5-coder is stable greedy, and greedy maximises tool
adherence, so its floor stays at 0.

**Thinking control.** Qwen3/3.5 are *hybrid* thinking models. For coding and
shell work the harness runs them with thinking **off** (`model.think = "auto"`)
— faster turns, and far more reliable tool calls, since the harness already
scaffolds reasoning itself (`DEEP_THINK` + the `think` tool). Set
`think = "always"` for hard one-shot reasoning. On Ollama this uses the native
`think` flag; on LM Studio / vLLM / llama.cpp it uses Qwen's documented
`/no_think` soft switch. Models with no thinking mode never receive the flag.

Everything here is overridable — see *Recommended settings* below.

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

### Recommended settings

Qwen 3.5 9B (default), with room for a real context window:

```toml
[model]
model = "qwen3.5:9b"
context_tokens = 32768  # qwen3.5 handles it; lower it if the KV cache won't fit
# temperature / top_p / top_k / penalties are auto-tuned per family — leave
# them alone unless you want to pin one.
think = "auto"          # "always" = deliberate every turn, "never" = never

[agent]
small_model_mode = true
max_retries = 4
```

Tight on VRAM (6–8 GB)? Drop to a 7B coder tune and a modest context:

```toml
[model]
model = "qwen2.5-coder:7b"
context_tokens = 8192
low_vram = true
```

Pinning a knob opts it out of auto-tuning; `auto_tune = false` disables the
mechanism entirely and uses your literal `[model]` values for every model.
`/model` in chat shows the family, the resolved thinking state, and exactly
which sampling values are in force.
