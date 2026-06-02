/**
 * Tolerant JSON extraction for small-model output. 7B models often wrap JSON in
 * prose or ```json fences, or emit trailing commas — recover what we can.
 */
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
  const open = text[start];
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
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
