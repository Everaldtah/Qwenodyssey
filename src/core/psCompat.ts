/**
 * Windows PowerShell 5.1 (what `run_shell` / `shell_session` spawn on Windows)
 * has no `&&` / `||` pipeline-chain operators — they arrived in PowerShell 7.
 * Small models write bash-style chains constantly ("python x.py && echo ok"),
 * and 5.1 answers with "The token '&&' is not a valid statement separator",
 * which then sends the model into a retry loop. Rewrite unquoted chains into
 * the equivalent `$?` checks so the command just works:
 *
 *   a && b        →  a; if ($?) { b }
 *   a || b        →  a; if (-not $?) { b }
 *   a && b || c   →  a; if ($?) { b }; if (-not $?) { c }
 *
 * Quoted text and `&&`/`||` inside quotes are left untouched. Commands without
 * an unquoted chain operator are returned unchanged.
 */
export function adaptChainsForPowerShell(cmd: string): string {
  const parts: { op: "&&" | "||" | null; text: string }[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let pendingOp: "&&" | "||" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      parts.push({ op: pendingOp, text: cur.trim() });
      pendingOp = two;
      cur = "";
      i++;
      continue;
    }
    cur += ch;
  }
  parts.push({ op: pendingOp, text: cur.trim() });
  if (parts.length === 1) return cmd; // no unquoted chain → untouched
  const out: string[] = [];
  for (const p of parts) {
    if (!p.text) continue;
    if (p.op === "&&") out.push(`if ($?) { ${p.text} }`);
    else if (p.op === "||") out.push(`if (-not $?) { ${p.text} }`);
    else out.push(p.text);
  }
  return out.join("; ");
}

/** True when this process will run commands through Windows PowerShell 5.1. */
export function usesWindowsPowerShell(): boolean {
  return process.platform === "win32";
}
