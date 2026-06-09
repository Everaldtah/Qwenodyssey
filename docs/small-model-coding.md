# Small-Model Coding Upgrades

This document describes the v0.3 upgrade aimed at making 7B–20B local models
code reliably — closing much of the gap to frontier models on well-scoped tasks
through better tools and tighter loops, not a bigger model.

## The philosophy

Small models don't fail at coding because they "can't code" — they fail in
*specific, repeatable ways*:

1. They botch unified diffs (wrong line numbers, drifted context).
2. They emit almost-valid JSON (trailing commas, single quotes, fences).
3. They edit the wrong place because they're guessing at code they can't see.
4. They don't check their own work.
5. A single sample has meaningful variance.

Each upgrade below targets one of these failure modes directly. None of them
make the harness bigger for its own sake.

## What was added

### 1. SEARCH/REPLACE edit blocks (`core/editBlock.ts`)

The single biggest lever. Instead of unified diffs or whole-file JSON, the model
emits:

```
path/to/file.ts
<<<<<<< SEARCH
exact code to find
=======
replacement code
>>>>>>> REPLACE
```

Matching is layered so a near-miss still lands:

| Strategy        | When it fires                                              |
|-----------------|------------------------------------------------------------|
| exact           | the SEARCH text is present verbatim                        |
| whitespace      | only indentation / trailing space differs                 |
| anchored-fuzzy  | first & last lines match; middle ≥ 75% similar             |
| reindented      | replacement re-flowed to the matched region's indentation  |

On failure, `explainFailure()` points the model at the closest line so its next
attempt is grounded.

### 2. Symbol index + navigation tools (`core/symbolIndex.ts`, `tools/codeTools.ts`)

A dependency-free, language-agnostic indexer (TS/JS, Python, Go, Rust, Java/
Kotlin, C/C++, Ruby, PHP) backing five tools that give a small model the
"IDE sense" a frontier model gets for free:

- `find_symbol` — where is X defined? (file:line + signature)
- `search_symbols` — fuzzy name search
- `outline_file` — a file's structure without reading it all
- `find_references` — every use of a name (blast radius before a rename)
- `read_symbol` — read one function/class, not the whole file
- `apply_edit` — apply one SEARCH/REPLACE block

The index is prewarmed at startup (`agent.prebuild_symbol_index`).

### 3. Verify-in-the-loop (`core/verifyLoop.ts`)

Auto-detects the project's check commands (npm scripts, tsc, pytest, ruff, mypy,
go test, cargo) and runs them after edits, returning a compact, de-duplicated,
file:line-prioritised error digest — not a wall of output — for the model to act
on.

### 4. Best-of-N candidate selection (`core/candidateSelect.ts`)

Draw N candidates, score each by an objective signal (parses? applies?
typechecks? tests pass?), keep the best. Early-accept short-circuits the moment a
clearly-good candidate appears, so the common case stays cheap. Failures across
samples are largely independent, so this recovers a large fraction of
single-sample variance.

### 5. Deterministic repair (`core/repair.ts`)

Fixes the common malformations in small-model JSON (fences, trailing commas,
single quotes, bare keys, python literals, unterminated strings) *without*
spending a model turn.

### 6. The pipeline that ties it together (`core/editPipeline.ts`)

```
generate (best-of-N edit blocks)
  → dry-run apply each candidate (reject non-applying)
  → apply the best with a rollback snapshot
  → verify (typecheck / lint / test)
  → on failure: feed the digest back, self-repair (bounded)
  → unrecoverable apply failure: roll back cleanly
```

The new `agents/editCoder.ts` drives this, and the orchestrator uses it by
default (`agent.edit_protocol = "blocks"`). The legacy JSON coder remains
available via `edit_protocol = "json"`.

## Configuration

```toml
[agent]
edit_protocol = "blocks"        # "blocks" (default) | "json"
candidates = 2                  # best-of-N sample count (1 disables)
verify_after_edit = true        # run checks + self-repair after editing
prebuild_symbol_index = true    # warm the index at startup
max_retries = 4                 # also caps self-repair rounds in deep mode
```

## Why not just use a bigger model / more code?

A coding harness gets *worse* as it bloats: more surface area for a small model
to get lost in, more untested paths, more to maintain. The capability multiplier
for a 7B–20B model is in these feedback loops and grounding tools, which is
exactly what this upgrade adds — about 2.5k lines of focused, tested code rather
than tens of thousands of padding.

## Tests

54 new tests across `editBlock`, `smallModelTools` (symbol index, repair,
candidate selection, verify), and `editPipeline` (integration, incl. a working
self-repair loop). Full suite: **80/80 passing**, clean `tsc --noEmit`,
clean `npm run build`. Verified end-to-end against the harness's own source
(1,003 symbols indexed, real navigation + edit + check detection).
