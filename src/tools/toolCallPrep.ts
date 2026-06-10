/**
 * Pre-dispatch hardening for tool calls coming from small models. Two jobs:
 *
 *  1. FUZZY NAME RESOLUTION — small models hallucinate tool names ("read" for
 *     "read_file", "search" for "grep"). We map an unknown name onto the nearest
 *     advertised tool within a small edit distance, or list suggestions.
 *  2. SCHEMA COERCION + VALIDATION — they also send the wrong JSON types
 *     ("true"/"1" for booleans, "5" for numbers), alias keys, or omit a required
 *     field. We coerce each argument to the type its schema declares and return a
 *     TARGETED message ("read_file needs `path`") instead of letting the tool
 *     fail with a cryptic error the model can't act on.
 *
 * The result feeds back into the chat loop: on a hard problem (unresolvable name
 * / missing required arg) we hand the model a corrective tool message rather than
 * dispatching a doomed call.
 */
import type { ToolSpec } from "../types";

export interface PreparedCall {
  /** Resolved tool name (may differ from the requested one after fuzzy-match). */
  name: string;
  /** Coerced arguments. */
  arguments: Record<string, any>;
  /** Set when the call cannot proceed; this string is fed back to the model. */
  error?: string;
  /** Non-fatal note (e.g. "interpreted `read` as `read_file`") to surface. */
  note?: string;
}

/** Classic Levenshtein edit distance (small strings — tool names). */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Resolve a (possibly hallucinated) tool name against the advertised set.
 * Exact match wins. Otherwise we accept the single nearest name within an edit
 * distance that scales with length (so "read"→"read_file" via substring, and
 * "grpe"→"grep" via distance), and only when it's unambiguously closest.
 */
export function resolveToolName(
  requested: string,
  known: string[]
): { name?: string; suggestions: string[] } {
  if (known.includes(requested)) return { name: requested, suggestions: [] };
  const lower = requested.toLowerCase();

  // Substring / prefix aliasing: "read" → "read_file", "web" → "web_search".
  const subs = known.filter(
    (k) => k.toLowerCase().startsWith(lower) || k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase())
  );
  if (subs.length === 1) return { name: subs[0], suggestions: [] };

  // Edit-distance: pick the closest within a length-scaled threshold.
  const scored = known
    .map((k) => ({ k, d: levenshtein(lower, k.toLowerCase()) }))
    .sort((x, y) => x.d - y.d);
  const threshold = Math.max(2, Math.floor(requested.length / 3));
  const best = scored[0];
  const second = scored[1];
  if (best && best.d <= threshold && (!second || second.d > best.d)) {
    return { name: best.k, suggestions: [] };
  }
  // Ambiguous: hand back a few suggestions for the model to pick from.
  const suggestions = (subs.length ? subs : scored.slice(0, 3).map((s) => s.k)).slice(0, 4);
  return { suggestions };
}

/** Coerce a single value to the JSON-schema `type` a small model probably fumbled. */
function coerceValue(value: any, schema: any): any {
  if (value === undefined || value === null || !schema) return value;
  const type = schema.type;
  switch (type) {
    case "string":
      return typeof value === "string" ? value : JSON.stringify(value);
    case "integer":
    case "number": {
      if (typeof value === "number") return value;
      const n = Number(String(value).trim());
      return Number.isFinite(n) ? (type === "integer" ? Math.trunc(n) : n) : value;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (/^(true|1|yes|on)$/i.test(String(value).trim())) return true;
      if (/^(false|0|no|off)$/i.test(String(value).trim())) return false;
      return value;
    case "array": {
      if (Array.isArray(value)) {
        return schema.items ? value.map((v: any) => coerceValue(v, schema.items)) : value;
      }
      // A model that sent a single scalar where a list was wanted → wrap it.
      if (typeof value === "string" && value.includes(",")) {
        return value.split(",").map((s) => s.trim()).filter(Boolean);
      }
      return [value];
    }
    case "object":
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    default:
      return value;
  }
}

/**
 * Validate + coerce a tool call against its advertised schema, after resolving
 * the tool name. Returns a PreparedCall the chat loop can either dispatch or feed
 * back to the model as a correction.
 */
export function prepareToolCall(
  name: string,
  args: Record<string, any> | undefined,
  specs: ToolSpec[]
): PreparedCall {
  const known = specs.map((s) => s.name);
  const resolved = resolveToolName(name, known);
  if (!resolved.name) {
    const hint = resolved.suggestions.length
      ? ` Did you mean: ${resolved.suggestions.join(", ")}?`
      : ` Available tools: ${known.join(", ")}.`;
    return { name, arguments: args ?? {}, error: `No tool named "${name}".${hint}` };
  }

  const spec = specs.find((s) => s.name === resolved.name)!;
  const note = resolved.name !== name ? `interpreted tool "${name}" as "${resolved.name}"` : undefined;

  const props: Record<string, any> = spec.parameters?.properties ?? {};
  const required: string[] = spec.parameters?.required ?? [];
  const out: Record<string, any> = { ...(args ?? {}) };

  for (const [key, sub] of Object.entries(props)) {
    if (key in out) out[key] = coerceValue(out[key], sub);
  }

  const missing = required.filter(
    (r) => out[r] === undefined || out[r] === null || (typeof out[r] === "string" && out[r].trim() === "")
  );
  if (missing.length) {
    const shape = required.map((r) => `${r}: ${props[r]?.type ?? "value"}`).join(", ");
    return {
      name: resolved.name,
      arguments: out,
      note,
      error:
        `Tool "${resolved.name}" is missing required argument(s): ${missing.join(", ")}. ` +
        `It needs { ${shape} }. Call it again with those fields filled in.`,
    };
  }

  return { name: resolved.name, arguments: out, note };
}
