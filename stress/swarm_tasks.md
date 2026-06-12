# Agent‑swarm stress probes (qwen2.5‑coder:7b orchestrator)

These test whether the 7B, as orchestrator, **knows when to fan out**, **decomposes
correctly**, and **synthesizes** the workers' answers — not pure code correctness.

## Prerequisites
- Swarm is only available when `swarmReady` = **≥2 workers**. Either set cloud keys
  (`NVIDIA_API_KEY` / `OPENROUTER_API_KEY`) so the `nvidia:`/`openrouter:` entries in
  `fallback_models` become workers, OR set `swarm.include_local = true` and have ≥2
  local models pulled.
- In chat, a real fan‑out shows as `⚙ agent_swarm …`. If you never see that line, the
  model chose not to swarm (or the tool wasn't loaded).

## How to score each probe
1. **Trigger** — did it call `agent_swarm` when it should (and NOT when it shouldn't)?
2. **Mode** — `divide` for independent parallel pieces; `ensemble` for one hard problem.
3. **Decomposition** — are the subtasks actually independent / correctly bounded?
4. **Synthesis** — is the merged final answer coherent and correct, not just stapled?

---

## A. Restraint — should NOT swarm (over‑trigger test)
**Prompt:** "Rename the variable `tmp` to `buffer` in this function and return it: `def f(): tmp=[]; return tmp`"
**Good:** answers directly, no swarm. **Fail:** spins up a swarm for a trivial edit.

## B. Restraint — quick lookup, no swarm
**Prompt:** "What's the time complexity of binary search?"
**Good:** one‑line answer, no swarm. **Fail:** ensembles a fact.

## C. Divide — independent parallel pieces (the core divide case)
**Prompt:** "Generate 4 INDEPENDENT standalone Python utilities, each self‑contained:
(1) `slugify(s)`, (2) a `retry(times)` decorator, (3) an `LRUCache` class,
(4) `parse_csv(text)->list[dict]`. Return all four."
**Good:** `agent_swarm` mode=`divide` with 4 subtasks → merged file with all 4.
**Fail:** writes them serially itself (ok but slow), or divides into dependent chunks.

## D. Decomposition trap — pieces are NOT independent
**Prompt:** "Build `module_b.py` whose `summarize()` calls `clean()` and `tokenize()`
from `module_a.py`, then build `module_a.py`. Make them work together."
**Good:** recognizes B depends on A — does NOT blindly `divide` them to separate
workers (or defines a shared interface first). **Fail:** shards A and B to different
workers that invent incompatible signatures → broken imports.

## E. Ensemble — one hard design problem, multiple perspectives
**Prompt:** "Design a rate‑limited async job queue with retries, backpressure, and
graceful shutdown. Give the architecture + a Python sketch, and compare two designs
(token‑bucket vs leaky‑bucket) with trade‑offs."
**Good:** `agent_swarm` mode=`ensemble` → synthesized design citing both approaches.
**Fail:** single shallow answer, or a swarm whose outputs aren't reconciled.

## F. Multi‑file scaffold — divide across files
**Prompt:** "Scaffold a minimal Flask API project: `app.py` (2 routes), `models.py`
(one dataclass), `test_app.py` (pytest for both routes), and a short `README.md`.
Return each file in its own code block."
**Good:** `divide` across the 4 files, consistent names across them, then assembled.
**Fail:** files reference each other with mismatched names/imports.

## G. Synthesis under disagreement
**Prompt:** "Is it better to use threads or asyncio for a web scraper hitting 500 URLs?
Get multiple expert opinions and give me one decisive recommendation with reasoning."
**Good:** ensemble → a single decisive answer that reconciles the views (I/O‑bound →
asyncio/aiohttp), not "here are 3 opinions". **Fail:** dumps raw worker answers.

## H. Big mixed job — divide with a dependency seam
**Prompt:** "Implement a tiny key‑value store: (a) an in‑memory `Store` class with
get/set/delete, (b) a `wal.py` write‑ahead log that `Store` uses for durability,
(c) a CLI `kv.py` wrapping it, (d) tests. Keep interfaces consistent."
**Good:** fixes the `Store`↔`wal` interface first, then parallelizes the independent
parts (CLI, tests); consistent across files. **Fail:** four workers, four
incompatible `Store` APIs.

---

## Realistic expectation
A 7B will reliably handle **A/B** (restraint) and can *follow* a `divide`/`ensemble`
once told, but it **under‑triggers** `agent_swarm` on its own and often **mis‑bounds**
decomposition on D/H (the dependency seams) — the same instruction‑following ceiling
the code suite showed. The dependable pattern is to make orchestration deterministic
(route hard/long turns to a swarm or a stronger model) rather than hoping the 7B
self‑invokes. To force a swarm for testing, you can also say explicitly: "use
agent_swarm in divide mode with these subtasks: …".
