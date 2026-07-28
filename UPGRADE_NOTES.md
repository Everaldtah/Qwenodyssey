# Qwenodyssey — Upgrade Notes

This pass fixes the live token counter and makes the harness more
token-efficient and more accurate across both local and frontier backends.

## 1. Token counter fix (the main bug)

**Before:** the `Spinner` was constructed with a single static token number and
only redrew the elapsed clock on a 140 ms timer. `provider.stream()` existed but
was never called — the chat loop used blocking `generate()`. So you saw one
stale "estimate" per request instead of a count climbing 1, 2, 3 …

**After:**

- The chat turn now **streams** the response (`streamWithFallback`), driving the
  spinner's new live output counter as deltas arrive.
- `Spinner` gained `bumpOut()` / `setOut()` / `setUp()` and now renders
  `↑ <prompt> ↓ <output> tokens · <tok/s>`, redrawing immediately on each token
  tick (throttled to ~60 ms so fast streams stay cheap).
- The `↓` count climbs live as the model generates; **tok/s** is measured from
  the first streamed token.
- When the stream's final usage frame arrives (exact `prompt_tokens` /
  `completion_tokens`), the live counts are **reconciled to the exact values**.

## 2. Real streaming on every OpenAI-compatible backend

`src/providers/base.ts` `stream()` now:

- Requests `stream_options: { include_usage: true }` so vLLM / llama.cpp /
  LM Studio / OpenRouter / NVIDIA NIM return **exact** token usage even while
  streaming.
- Parses **streamed tool-call fragments** (name on the first frame, arguments
  concatenated across later frames) and assembles them into finished tool calls
  — so tool-calling works on the streaming path, not just the blocking one.
- Falls back to a heuristic completion count if a server omits the usage frame.

`src/providers/ollama.ts` gained a **native streaming override** for
`/api/chat` (newline-delimited JSON, not SSE), counting `eval_count` for exact
usage and surfacing the `thinking` field live for reasoning models.

## 3. Better, consistent token estimation

`countTokens()` was a flat `len / 4`, which badly mis-estimates code (many short
symbol tokens) and CJK (~1 token/char). It's now a **structure-aware heuristic**
(word runs × 1.3 + standalone symbols + CJK chars, with a byte-rate floor),
empirically within ~10–15 % of real BPE tokenizers for mixed code+prose. Exact
backend `usage` always overrides it.

`contextBuilder.ts` now uses the provider tokenizer for budget packing instead
of its own independent `len / 4`, so the context budget, compaction trigger, and
the meter all agree.

## 4. Live (voice) command

The text path in `live.ts` now streams too, so its token meter ticks live and
reconciles to exact usage. (The omni/audio path is unchanged — that API doesn't
expose deltas.)

## 5. Robustness

- Streaming has the **same unavailable-model fallback chain** as the blocking
  path, plus a graceful fall-back to blocking `generate()` if streaming fails
  for a non-availability reason — the turn always completes.
- `TokenMeter.record()` accepts a heuristic estimate so session totals never
  freeze at 0 when a backend omits usage.

## Tests

Added `tests/streaming.test.ts` (10 tests): SSE delta accumulation, frame split
across network chunks, streamed tool-call assembly, usage-frame fallback,
`countTokens` behaviour (incl. CJK + code), `formatTokens`, and the live
spinner counter. Full suite: **36/36 passing**, clean `tsc --noEmit`.

---

# v0.3 — Small-model coding uplift

A second pass focused on making 7B–20B local models code *reliably*. Full
detail in `docs/small-model-coding.md`; summary:

- **SEARCH/REPLACE edit blocks** (`core/editBlock.ts`) — replaces unified diffs
  (which small models botch) with whitespace-tolerant, auto-reindenting,
  fuzzy-matched edits. Targeted failure feedback on a miss.
- **Symbol index + navigation tools** (`core/symbolIndex.ts`, `tools/codeTools.ts`)
  — `find_symbol`, `search_symbols`, `outline_file`, `find_references`,
  `read_symbol`, `apply_edit`. Language-agnostic, dependency-free, prewarmed at
  startup. Gives a small model the IDE grounding a frontier model gets for free.
- **Verify-in-the-loop** (`core/verifyLoop.ts`) — auto-detects and runs
  typecheck/lint/test, returns a compact file:line-prioritised error digest.
- **Best-of-N selection** (`core/candidateSelect.ts`) — sample several edits,
  keep the one that applies/compiles/passes; early-accept keeps it cheap.
- **Deterministic JSON repair** (`core/repair.ts`) — fixes fences, trailing
  commas, single quotes, bare keys, unterminated strings without a model turn.
- **Integrated pipeline** (`core/editPipeline.ts`, `agents/editCoder.ts`) —
  generate → dry-run → apply-with-rollback → verify → self-repair. Now the
  orchestrator default (`agent.edit_protocol = "blocks"`).

New config: `edit_protocol`, `candidates`, `verify_after_edit`,
`prebuild_symbol_index`.

54 new tests (80/80 total), clean typecheck + build, verified end-to-end against
the harness's own source. This is ~2.5k lines of focused, tested code — the
capability gain for small models comes from these loops, not from line count.

## Design note

Output text is still buffered and printed once after the spinner clears (not
echoed delta-by-delta), because the turn logic post-processes the full response
— stripping reasoning-model chain-of-thought, detecting fenced commands, and
parsing tool calls — before showing anything. Live raw-delta echo would dump
unprocessed `<think>` blocks and pondered commands to the screen. The live
feedback during generation is the ticking token meter. True live text streaming
is a deeper turn-state-machine change if wanted later.

---

# Model-aware decoding pass (v0.4.0)

The harness had **one** global temperature/top_p for every backend and a regex
that decided "is this a reasoning model?" — which did not recognise Qwen 3 / 3.5
at all. On a Qwen 3.5 9B that meant greedy tool turns (the exact setting Qwen
warns causes repetition loops) and no way to control thinking. This pass makes
decoding a property of the MODEL, not of the config file.

## 1. Model profiles (`src/core/modelProfile.ts`, new)

Classifies the active model by name into a family — `qwen3` / `qwen3-coder`,
`qwen2.5` / `qwen2.5-coder`, `deepseek-r1`, `qwq`, `gemma`, generic reasoning,
generic — and returns:

- `reasoning` / `hybridThinking` / `thinkByDefault` — what the model *is*, and
  whether its chain-of-thought can be switched off at all;
- separate `thinking` / `nonThinking` sampling profiles (temperature, top_p,
  top_k, presence & repeat penalties) from each family's published guidance,
  plus a `minTurnTemp` floor for agent tool turns;
- a `contextSuggestion` used as a hint in `/model`.

One classifier now serves the whole harness: `core/swarm.ts` re-exports
`isReasoningModel` from here instead of keeping a second copy of the regex.

## 2. Auto-tuning (`providers/index.ts` → `tuneForModel`)

Local provider construction (primary, model picker, fallback chain) folds the
profile's recommendations into the provider config **only where the user left
`[model]` at its defaults** — an explicit setting always wins, and
`model.auto_tune = false` turns the mechanism off entirely.

## 3. Thinking control end to end

New `model.think = "auto" | "always" | "never"`:

- `auto` — hybrids (Qwen3/3.5) run with thinking **off** for fast, tool-shaped
  coding/shell turns; pure reasoners (R1/QwQ) deliberate as before.
- Ollama uses the native `think` flag (now able to send `think: false`, which
  the provider previously could not express); OpenAI-compatible backends use
  Qwen's `/no_think` soft switch on the last user message.
- Models with no thinking mode never receive the flag, and `never` cannot
  produce an unsupported request against a model that always thinks.

## 4. Turn temperature

`turnTemperature()` no longer branches on a boolean. It starts at 0 and lifts to
the highest applicable floor: the family's (`0.6` thinking, `0.3` Qwen3
non-thinking, `0` for greedy-stable coders) and the cloud anti-degeneration
floor. Behaviour for previously-recognised models is unchanged.

## 5. New sampling knobs

`model.top_k`, `model.repeat_penalty`, `model.presence_penalty` (0 = unset, so
nothing extra goes on the wire), `model.auto_tune`, `model.think`. Ollama maps
them to `top_k` / `repeat_penalty` / `presence_penalty`; OpenAI-compatible
servers get `top_k` / `repetition_penalty` / `presence_penalty`. The Ollama
provider's duplicated generate/stream body construction collapsed into one
`chatBody()` so the two paths cannot drift.

## 6. Defaults

Default model is now `qwen3.5:9b`, with `qwen2.5-coder:7b` added to the fallback
chain. `/model` gained rows for the detected family, the resolved thinking
state, the live sampling values, and a context-window hint.

21 new tests (214 total), clean typecheck.
