/**
 * Tolerant JSON extraction for small-model output. 7B models often wrap JSON in
 * prose or ```json fences, or emit trailing commas — recover what we can.
 * Falls back to core/repair.ts for the harder malformations (single quotes,
 * unquoted keys, unterminated strings at the token limit).
 */
import { repairJson } from "./repair";
export function extractJson<T = any>(text: string): T | undefined {
  if (!text) return undefined;

  // 1. Fenced ```json block
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fence) candidates.push(fence[1]);

  // 2. First balanced {...} or [...] span
  const span = balancedSpan(text);
  if (span) candidates.push(span);

  // 3. Whole string
  candidates.push(text.trim());

  for (const c of candidates) {
    const parsed = tryParse<T>(c);
    if (parsed !== undefined) return parsed;
  }
  // Escalate: deterministic repair of the harder malformations (single-quoted
  // strings, bare keys, Python literals, unterminated trailing string).
  for (const c of candidates) {
    const r = repairJson<T>(c);
    if (r.ok) return r.value;
  }
  return undefined;
}

function tryParse<T>(s: string): T | undefined {
  const cleaned = s
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .replace(/,\s*([}\]])/g, "$1") // trailing commas
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return undefined;
  }
}

function balancedSpan(text: string): string | undefined {
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  return balancedSpanAt(text, start)?.text;
}

/** The balanced {…}/[…] span starting at `start`, plus the index just past it. */
function balancedSpanAt(text: string, start: number): { text: string; end: number } | undefined {
  const open = text[start];
  if (open !== "{" && open !== "[") return undefined;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { text: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return undefined;
}

/**
 * Every top-level balanced JSON value embedded in free text, parsed loosely.
 * Small models often emit one or more tool-call objects inline (sometimes in
 * separate ```json fences); this recovers all of them in document order.
 */
export function extractAllJson(text: string): any[] {
  if (!text) return [];
  const out: any[] = [];
  let i = 0;
  while (i < text.length) {
    const rel = text.slice(i).search(/[{[]/);
    if (rel === -1) break;
    const start = i + rel;
    const span = balancedSpanAt(text, start);
    if (!span) {
      i = start + 1;
      continue;
    }
    let parsed = tryParse(span.text);
    if (parsed === undefined) {
      // Near-valid span (single quotes, bare keys…) — try deterministic repair
      // before giving up, so a malformed inline tool call still executes.
      const r = repairJson(span.text);
      if (r.ok) parsed = r.value;
    }
    if (parsed !== undefined) out.push(parsed);
    i = span.end;
  }
  return out;
}
