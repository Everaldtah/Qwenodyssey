# CLI usage

Global flags (work on any command):

- `--cwd <dir>` — operate on another project directory
- `--verbose` — print debug detail
- `-y, --yes` — auto-confirm all prompts (CI / scripting)

## Commands

### init
```bash
qwenodyssey init [--force]
```
Creates `.qwenodyssey/` with `config.toml`, `memory/`, `patches/`, `logs/`, `cache/`.

### config
```bash
qwenodyssey config list
qwenodyssey config get model.provider
qwenodyssey config set model.model qwen2.5-coder:7b
qwenodyssey config path
```

### code
```bash
qwenodyssey code "add JWT auth to the API" [--fast|--safe|--deep|--autofix]
```
Runs the full pipeline. Default mode is `safe` when `small_model_mode` is on.

### edit
```bash
qwenodyssey edit src/auth.ts "return 401 instead of 500 on bad token"
```

### plan
```bash
qwenodyssey plan "migrate from callbacks to async/await"
```

### review
```bash
qwenodyssey review     # reviews current uncommitted git diff
```

### test
```bash
qwenodyssey test       # detects and runs your test command
```

### apply
```bash
qwenodyssey apply              # apply edits left pending from a `code` run
qwenodyssey apply --rollback   # undo the most recent applied patch
```

### memory
```bash
qwenodyssey memory add "the API base path is /v2" --category project
qwenodyssey memory search auth
qwenodyssey memory list
qwenodyssey memory clear
```

### chat
```bash
qwenodyssey chat
# @src/app.ts inlines a file, /reset clears history, /exit quits
```
