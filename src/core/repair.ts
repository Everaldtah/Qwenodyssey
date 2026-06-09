/**
 * Deterministic repair for small-model structured output.
 *
 * 7B–20B models frequently emit *almost* valid JSON: trailing commas, single
 * quotes, unquoted keys, ```json fences, smart quotes, a stray prose preamble,
 * an unterminated string at the token limit. Rather than burn a turn asking the
 * model to "try again", we repair the common failure shapes deterministically
 * and only escalate to a re-ask if repair genuinely fails.
 *
 * This complements core/parse.ts (which extracts a JSON span); here we focus on
 * *fixing* a span that didn't parse.
 */

export interface RepairResult<T = unknown> {
  ok: boolean;
  value?: T;
  repaired: boolean;
  notes: string[];
}

/** Strip markdown code fences and any prose before the first JSON delimiter. */
function stripToJson(text: string): string {
  let s = text.trim();
  // Remove ```json ... ``` fences.
  s = s.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "");
  // Cut to the first { or [ and the last } or ].
  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start > 0) s = s.slice(start);
  const lastObj = s.lastIndexOf("}");
  const lastArr = s.lastIndexOf("]");
  const end = Math.max(lastObj, lastArr);
  if (end >= 0 && end < s.length - 1) s = s.slice(0, end + 1);
  return s.trim();
}

/** Normalise quotes/commas/keys that small models commonly get wrong. */
function normalizeJsonish(s: string): string {
  let out = s;
  // Smart quotes → straight quotes.
  out = out.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  // Trailing commas before } or ].
  out = out.replace(/,\s*([}\]])/g, "$1");
  // Python literals.
  out = out.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null");
  return out;
}

/**
 * Convert single-quoted strings/keys to double-quoted, *outside* of existing
 * double-quoted strings. A small state machine so we don't corrupt apostrophes
 * inside valid strings.
 */
function singleToDoubleQuotes(s: string): string {
  let out = "";
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const prev = s[i - 1];
    if (c === '"' && prev !== "\\" && !inSingle) {
      inDouble = !inDouble;
      out += c;
    } else if (c === "'" && prev !== "\\" && !inDouble) {
      inSingle = !inSingle;
      out += '"'; // re-emit as a double quote
    } else {
      out += c;
    }
  }
  return out;
}

/** Quote bare object keys: {key: 1} → {"key": 1}. */
function quoteBareKeys(s: string): string {
  return s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
}

/** Best-effort close of an unterminated trailing string + open brackets. */
function closeUnterminated(s: string): string {
  let out = s;
  // Count unescaped double quotes; if odd, the last string is unterminated.
  const quotes = (out.match(/(?<!\\)"/g) || []).length;
  if (quotes % 2 === 1) out += '"';
  // Balance braces/brackets.
  const opensCurly = (out.match(/\{/g) || []).length;
  const closesCurly = (out.match(/\}/g) || []).length;
  const opensSq = (out.match(/\[/g) || []).length;
  const closesSq = (out.match(/\]/g) || []).length;
  out += "]".repeat(Math.max(0, opensSq - closesSq));
  out += "}".repeat(Math.max(0, opensCurly - closesCurly));
  return out;
}

/**
 * Parse JSON, repairing common small-model malformations. Returns the parsed
 * value plus whether repair was needed and what was done.
 */
export function repairJson<T = unknown>(text: string): RepairResult<T> {
  const notes: string[] = [];

  // Fast path: already valid.
  try {
    return { ok: true, value: JSON.parse(text) as T, repaired: false, notes };
  } catch {
    /* fall through to repair */
  }

  let s = stripToJson(text);
  if (s !== text.trim()) notes.push("stripped fences/prose");

  const attempts: { label: string; fn: (x: string) => string }[] = [
    { label: "normalize quotes/commas", fn: normalizeJsonish },
    { label: "single→double quotes", fn: (x) => singleToDoubleQuotes(normalizeJsonish(x)) },
    { label: "quote bare keys", fn: (x) => quoteBareKeys(singleToDoubleQuotes(normalizeJsonish(x))) },
    { label: "close unterminated", fn: (x) => closeUnterminated(quoteBareKeys(singleToDoubleQuotes(normalizeJsonish(x)))) },
  ];

  for (const a of attempts) {
    try {
      const fixed = a.fn(s);
      const val = JSON.parse(fixed) as T;
      notes.push(a.label);
      return { ok: true, value: val, repaired: true, notes };
    } catch {
      /* try next strategy */
    }
  }

  return { ok: false, repaired: true, notes: [...notes, "all repair strategies failed"] };
}

/**
 * Coerce a value to an array of T. Small models sometimes return a single
 * object where an array was expected, or wrap the array in a key.
 */
export function coerceArray<T = unknown>(value: unknown, keys: string[] = ["items", "results", "edits", "steps", "issues"]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
    return [value as T]; // single object → one-element array
  }
  return [];
}
