# Memory

Project memory lives under `.qwenodyssey/memory/` as plain markdown so it's
human-readable and git-friendly (it is gitignored by default; remove the ignore
rule if you want to commit shared project knowledge).

| File | Holds |
|------|-------|
| `project.md` | architecture facts, conventions, structure |
| `user.md` | the developer's preferences |
| `decisions.md` | why choices were made |
| `commands.md` | useful project commands |

## Commands

```bash
qwenodyssey memory add "tests live in tests/ and run with vitest" --category project
qwenodyssey memory search vitest
qwenodyssey memory list
qwenodyssey memory clear
```

During a `code` run, memory is included in the context (lowest priority, so it
never crowds out the actual files).

## Planned

- Vector-database memory for semantic recall instead of keyword search.
- Automatic fact extraction from sessions (the `memory.md` prompt template is
  already shipped for this).
