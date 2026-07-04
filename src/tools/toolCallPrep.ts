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

/**
 * Curated aliases for tool names small models hallucinate. These come from
 * OTHER harnesses' tool vocabularies baked into model training data (Claude
 * Code's str_replace_editor, OpenHands' execute_command, generic "bash"/"cat"/
 * "ls"). Deterministic table lookup beats fuzzy matching for these: "bash" is
 * nowhere near "run_shell" by edit distance, yet the intent is unambiguous.
 * Only applied when the target tool is actually advertised.
 */
const TOOL_ALIASES: Record<string, string> = {
  // shell
  bash: "run_shell", shell: "run_shell", sh: "run_shell", powershell: "run_shell",
  terminal: "run_shell", exec: "run_shell", execute: "run_shell",
  execute_command: "run_shell", run_command: "run_shell", run_terminal_cmd: "run_shell",
  shell_command: "run_shell", cmd: "run_shell",
  // file reads
  cat: "read_file", open: "read_file", open_file: "read_file", view: "read_file",
  view_file: "read_file", get_file: "read_file", show_file: "read_file",
  // file writes/edits
  write: "write_file", create_file: "write_file", save_file: "write_file",
  new_file: "write_file", edit_file: "apply_edit", str_replace_editor: "apply_edit",
  str_replace: "apply_edit", replace_in_file: "apply_edit", edit: "apply_edit",
  // listing / search
  ls: "list_files", dir: "list_files", list_dir: "list_files",
  list_directory: "list_files", find: "list_files", glob: "list_files",
  search: "grep", search_files: "grep", search_code: "grep", code_search: "grep",
  rg: "grep", ripgrep: "grep", search_file_content: "grep",
  // web
  search_web: "web_search", google: "web_search", internet_search: "web_search",
  browse: "web_fetch", fetch: "web_fetch", fetch_url: "web_fetch",
  get_url: "web_fetch", curl: "web_fetch", open_url: "web_fetch",
  // memory
  remember: "knowledge_save", save_memory: "knowledge_save", memorize: "knowledge_save",
  recall: "knowledge_search", memory_search: "knowledge_search", search_memory: "knowledge_search",
  // planning
  todo: "update_plan", todo_write: "update_plan", plan: "update_plan",
  update_todo: "update_plan", create_plan: "update_plan",
  // deliberation
  thought: "think", thinking: "think", reflect: "think", reflection: "think",
  reason: "think", internal_monologue: "think",
};

/**
 * Aliases for ARGUMENT keys small models substitute for the schema's real key
 * ({"file": "x.ts"} for read_file, {"cmd": "…"} for run_shell). For each schema
 * property that is missing, we adopt the value of the first alias present —
 * but never steal a key that is itself a valid property of the same tool.
 */
const ARG_ALIASES: Record<string, string[]> = {
  path: ["file", "filename", "file_path", "filepath", "file_name", "directory", "dir", "folder", "target"],
  command: ["cmd", "script", "shell_command", "command_line", "input"],
  content: ["text", "contents", "body", "data", "file_text", "new_content", "code"],
  pattern: ["regex", "regexp", "search", "search_pattern", "search_term", "search_string"],
  query: ["q", "search_query", "question", "topic", "keywords"],
  url: ["link", "uri", "website", "address"],
  search: ["old_str", "old_string", "old_text", "find", "original"],
  replace: ["new_str", "new_string", "new_text", "replacement", "updated"],
  name: ["symbol", "symbol_name", "function_name", "identifier"],
  timeout_ms: ["timeout", "timeout_seconds", "max_time"],
  thought: ["thinking", "reasoning", "reflection", "analysis"],
};

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

  // Curated alias table first — deterministic and cheap. Models trained on other
  // harnesses emit "bash"/"cat"/"str_replace_editor"; edit distance can't bridge
  // those, a lookup can. Also try with a hallucinated namespace prefix stripped
  // ("functions.run_shell", "tools.read_file", "default_api.grep").
  const deprefixed = lower.replace(/^(functions?|tools?|default_api|api|assistant)[._:/]/, "");
  for (const cand of [lower, deprefixed]) {
    const exact = known.find((k) => k.toLowerCase() === cand);
    if (exact) return { name: exact, suggestions: [] };
    const alias = TOOL_ALIASES[cand];
    if (alias && known.includes(alias)) return { name: alias, suggestions: [] };
  }

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
  let note = resolved.name !== name ? `interpreted tool "${name}" as "${resolved.name}"` : undefined;

  const props: Record<string, any> = spec.parameters?.properties ?? {};
  const required: string[] = spec.parameters?.required ?? [];
  const out: Record<string, any> = { ...(args ?? {}) };

  // Argument-key aliasing: a small model sent {"file": …} where the schema says
  // `path`, or {"cmd": …} for `command`. For each MISSING schema property, adopt
  // the first alias the model did send — unless that alias is itself a real
  // property of this tool (never steal a legitimate argument).
  const aliasNotes: string[] = [];
  for (const [canonical, aliases] of Object.entries(ARG_ALIASES)) {
    if (!(canonical in props) || out[canonical] !== undefined) continue;
    for (const a of aliases) {
      if (a in props) continue;
      if (out[a] !== undefined) {
        out[canonical] = out[a];
        delete out[a];
        aliasNotes.push(`\`${a}\` → \`${canonical}\``);
        break;
      }
    }
  }
  // Drop keys the schema doesn't declare — noise for the tool, and some
  // dispatchers hard-reject extras. Skipped for open schemas (no declared
  // properties, or additionalProperties allowed — common for MCP tools).
  const openSchema =
    Object.keys(props).length === 0 || spec.parameters?.additionalProperties === true;
  if (!openSchema) {
    for (const key of Object.keys(out)) {
      if (!(key in props)) delete out[key];
    }
  }

  for (const [key, sub] of Object.entries(props)) {
    if (key in out) out[key] = coerceValue(out[key], sub);
  }

  if (aliasNotes.length) {
    const a = `mapped argument ${aliasNotes.join(", ")}`;
    note = note ? `${note}; ${a}` : a;
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
