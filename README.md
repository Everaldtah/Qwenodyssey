# Qwenodyssey

**An Odyssey-class coding harness for Qwen 2.5 7B.**

Qwenodyssey is a local-first CLI coding agent that wraps a small/medium model
(Qwen 2.5 7B / Qwen2.5-Coder-7B) in the scaffolding it needs to behave like a
much stronger coding agent: explicit planning, constrained context, patch-based
edits, self-review, a test→fix retry loop, and project memory.

It is a clean-room TypeScript evolution that combines:

- **Odysseus**-style multi-agent orchestration and a step-by-step task pipeline.
- **opencode**-style terminal coding-agent UX (interactive chat, diffs, approvals,
  provider abstraction).

> No source from those projects is copied — only design ideas were adapted.

---

## Why a 7B model needs a harness

A 7B model is fast and private, but compared to frontier models it forgets,
hallucinates APIs, and loses the thread on large tasks. Qwenodyssey compensates
*structurally* instead of pretending the model is bigger than it is:

- **Give it smaller tasks** — the planner decomposes work into 2–6 steps.
- **Show it only relevant files** — the context engine packs a token budget by priority.
- **Force plans & patches** — structured JSON output, unified diffs, not essays.
- **Run real tests** — feedback comes from the actual test suite, not vibes.
- **Review its own output** — a reviewer agent checks before edits are applied.
- **Retry on real errors** — failures feed an error-fix loop, bounded by config.
- **Remember decisions** — per-project memory survives across sessions.

See [`docs/qwen-optimization.md`](docs/qwen-optimization.md).

---

## Installation

```bash
# from source (current)
git clone https://github.com/Everaldtah/Qwenodyssey
cd Qwenodyssey
npm install
npm run build
npm link        # exposes the `qwenodyssey` command globally
```

Requires **Node.js 18+** and a running model backend (see below).

---

## Quick start

```bash
cd your-project
qwenodyssey init
qwenodyssey config set model.provider ollama
qwenodyssey config set model.model qwen2.5-coder:7b
qwenodyssey code "create a function that validates email addresses and add tests"
```

Qwenodyssey will scan the repo, build a plan, show proposed diffs, ask for
approval, apply the patch, run your tests, and summarize.

---

## Model backends

Qwenodyssey talks to any OpenAI-compatible endpoint.

### Ollama (default)
```bash
ollama pull qwen2.5-coder:7b
qwenodyssey config set model.provider ollama
qwenodyssey config set model.base_url http://localhost:11434
qwenodyssey config set model.model qwen2.5-coder:7b
```

### LM Studio
Start the local server, then:
```bash
qwenodyssey config set model.provider lmstudio
qwenodyssey config set model.base_url http://localhost:1234
```

### OpenAI-compatible / vLLM / llama.cpp
```bash
qwenodyssey config set model.provider openai      # or vllm / llamacpp
qwenodyssey config set model.base_url https://your-endpoint
qwenodyssey config set model.api_key sk-...        # or env QWENODYSSEY_API_KEY
```

### NVIDIA NIM (cloud)
Use a strong hosted model (e.g. `moonshotai/kimi-k2.6`) as the primary brain or a
fallback. Set your key via the `NVIDIA_API_KEY` environment variable — **never commit it**.
```bash
# PowerShell (persisted for your user):
setx NVIDIA_API_KEY "nvapi-..."
# then, in a new shell:
qwenodyssey config set model.provider nvidia
qwenodyssey config set model.model moonshotai/kimi-k2.6
```
`nvidia:<model>` refs also work in `fallback_models` (the default chain includes
`nvidia:moonshotai/kimi-k2.6`, used automatically only when a key is present).
Endpoint: `https://integrate.api.nvidia.com/v1`. If the key is missing or the call
fails (auth/quota/network), Qwenodyssey transparently falls back to a local model.

See [`docs/providers.md`](docs/providers.md).

---

## Commands

| Command | Description |
|---------|-------------|
| `qwenodyssey init` | Create the `.qwenodyssey` workspace |
| `qwenodyssey chat` | Interactive pair-coding chat (streaming) |
| `qwenodyssey code "task"` | Full pipeline: plan → edit → review → test |
| `qwenodyssey edit <file> "instruction"` | Edit a single file |
| `qwenodyssey plan "goal"` | Produce a plan without editing |
| `qwenodyssey review` | Review the current git diff |
| `qwenodyssey test` | Detect & run the project's tests |
| `qwenodyssey apply [--rollback]` | Apply pending edits / roll back last patch |
| `qwenodyssey memory add/search/list/clear` | Project memory |
| `qwenodyssey config get/set/list` | Configuration |

### Modes (on `code`)
- `--fast` — minimal planning, direct edit
- `--safe` — plan + review + confirm (**default** in `small_model_mode`)
- `--deep` — plan + code + review + test + retry loop
- `--autofix` — run tests, diagnose, patch, repeat

See [`docs/cli-usage.md`](docs/cli-usage.md).

---

## Example session

```
$ qwenodyssey code "add an isPrime helper and a test"

→ Scanning repo…
→ Planning…

Proposed plan: Add an isPrime utility with tests
Files likely needed:
  - src/math.ts
Steps:
  1. Add isPrime(n) to src/math.ts
  2. Add tests in tests/math.test.ts
Proceed with this plan? (Y/n)

CREATE src/math.ts
+ export function isPrime(n: number): boolean { ... }

Reviewing… approved
Apply these edits? (Y/n) y
✓ create src/math.ts
✓ create tests/math.test.ts
→ Running tests… ✓ Tests passed.

── Summary ──
Added isPrime() and a passing test. No other files touched.
```

More in [`docs/examples.md`](docs/examples.md).

---

## Safety

- Dangerous shell commands (`rm -rf /`, `mkfs`, `dd`, fork bombs, `shutdown`…) are
  **hard-blocked**; other destructive commands require confirmation.
- Every tool call is logged to `.qwenodyssey/logs/session-*.jsonl`.
- Edits are journaled to `.qwenodyssey/patches/` and can be rolled back.
- Qwenodyssey warns when the working tree is dirty before applying changes.

---

## Roadmap

- [ ] VS Code & Cursor integration
- [ ] Claude Code compatibility mode
- [ ] OpenClaw plugin
- [ ] MCP (Model Context Protocol) support
- [ ] Browser/research tool
- [ ] Vector-database memory (semantic recall)
- [ ] Multi-model debate mode
- [ ] Qwen 14B/32B profiles
- [ ] Remote sandbox workers
- [ ] Tree-sitter symbol extraction for sharper context

See [`docs/architecture.md`](docs/architecture.md) for the design and current
status of each subsystem.

## License

MIT — see [LICENSE](LICENSE).
