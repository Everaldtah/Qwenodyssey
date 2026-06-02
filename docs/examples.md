# Examples

### 1. New utility + tests (acceptance flow)
```bash
qwenodyssey init
qwenodyssey config set model.provider ollama
qwenodyssey config set model.model qwen2.5-coder:7b
qwenodyssey code "create a function that validates email addresses and add tests"
```
Expected: scans repo → plan → diff → approval → apply → run tests → summary.

### 2. Fast one-file edit
```bash
qwenodyssey edit src/server.ts "add a /health route returning {status:'ok'}" --yes
```

### 3. Deep mode with retry loop
```bash
qwenodyssey code "fix the failing date parsing in src/dates.ts" --deep
```
Runs plan → code → review → test, and if tests fail, diagnoses and patches up to
`agent.max_retries` times.

### 4. Autofix an existing failure
```bash
qwenodyssey code "" --autofix
```
Skips codegen, runs the test suite, and iteratively patches until green or the
retry budget is exhausted.

### 5. Pair-coding chat
```bash
qwenodyssey chat
you › how is auth wired up? @src/auth.ts
qwen › …
```

### 6. Review before committing
```bash
qwenodyssey review
```

### 7. Roll back the last change
```bash
qwenodyssey apply --rollback
```
