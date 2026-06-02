# Tool system

Tools implement a tiny interface (`src/types.ts → Tool`) and are registered in
`src/tools/registry.ts`. Each receives a `ToolContext` (cwd, confirmation flags,
shell permission, logger).

## Built-in tools

| Tool | Mutating | Notes |
|------|----------|-------|
| `read_file` | no | path-confined to project root |
| `write_file` | yes | creates parent dirs |
| `create_file` | yes | fails if exists |
| `delete_file` | yes | |
| `list_files` | no | glob, sensible ignore list |
| `tree` | no | depth-limited |
| `grep` | no | regex over repo |
| `search_docs` | no | README + docs/ keyword search |
| `git_status` | no | simple-git |
| `git_diff` | no | simple-git |
| `run_shell` | yes | **safety-gated** (see below) |

Patch application (`apply_patch` / `rollback_patch` semantics) is handled by
`core/patchEngine.ts` and surfaced through `qwenodyssey apply`.

## Shell safety

`src/tools/shellTools.ts → classifyCommand` sorts commands into:

- **blocked** — never run (e.g. `rm -rf /`, `mkfs`, `dd if=`, `shutdown`,
  fork bombs, `format C:`). Returned as a refusal.
- **destructive** — require confirmation when `tools.confirm_destructive` is on
  and `--yes` was not passed (e.g. `rm`, `git reset --hard`, `git push --force`,
  `DROP TABLE`).
- **safe** — run directly.

All commands run with the project as cwd and a 120s timeout, and every call is
logged. Path-based file tools refuse to escape the project root.

## Adding a tool

```ts
export const myTool: Tool = {
  name: "my_tool",
  description: "…",
  mutating: false,
  async run(args, ctx) { return { ok: true, output: "…" }; },
};
// then registry.register(myTool)
```
