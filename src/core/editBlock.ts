/**
 * Edit-block engine — the single biggest lever for small-model coding accuracy.
 *
 * Small models (7B–20B) produce *unreliable* unified diffs: off-by-one hunk
 * headers, drifted context lines, wrong line counts. They are far more reliable
 * at "here is the exact block I want to find, here is what to replace it with".
 * This module implements that protocol (inspired by Aider's SEARCH/REPLACE
 * blocks, reimplemented from scratch) with several layers of tolerance so a
 * near-miss is repaired deterministically instead of failing the turn:
 *
 *   1. Exact match.
 *   2. Whitespace-normalised match (leading indent / trailing space differences).
 *   3. Anchored fuzzy match (first & last non-blank lines must match, the middle
 *      is matched by similarity above a threshold).
 *   4. Indentation re-flow: the replacement is re-indented to match the matched
 *      region, so a model that dropped or guessed indentation still lands right.
 *
 * The wire format the model emits (parsed by parseEditBlocks):
 *
 *   path/to/file.ts
 *   <<<<<<< SEARCH
 *   original code
 *   =======
 *   replacement code
 *   >>>>>>> REPLACE
 *
 * A block with an empty SEARCH section creates/appends; a block whose file does
 * not exist creates it. Multiple blocks per file are applied in order.
 */
import * as fs from "fs";
import * as path from "path";

export interface EditBlock {
  /** Target file path (relative to project root). */
  path: string;
  /** The text to find. Empty string ⇒ create file / append. */
  search: string;
  /** The text to substitute in. */
  replace: string;
}

export type MatchStrategy =
  | "exact"
  | "whitespace"
  | "anchored-fuzzy"
  | "reindented"
  | "created"
  | "appended";

export interface BlockApplyResult {
  path: string;
  ok: boolean;
  strategy?: MatchStrategy;
  /** Similarity score 0..1 for fuzzy matches (1 = exact). */
  confidence?: number;
  error?: string;
  /** Pre-image, for journaling / rollback. null = file didn't exist. */
  before: string | null;
  after?: string;
}

const FENCE_SEARCH = /^<{5,9}\s*SEARCH\s*$/;
const FENCE_DIVIDER = /^={5,9}\s*$/;
const FENCE_REPLACE = /^>{5,9}\s*REPLACE\s*$/;

/**
 * Parse SEARCH/REPLACE blocks out of a model response. Tolerant of:
 *  - the path appearing on the line above the fence, or as a ```lang path``` header
 *  - fences of 5–9 markers (models vary)
 *  - surrounding prose and code fences
 */
export function parseEditBlocks(text: string): EditBlock[] {
  const lines = (text || "").split("\n");
  const blocks: EditBlock[] = [];
  let i = 0;
  let pendingPath = "";

  const looksLikePath = (s: string): boolean => {
    const t = s.trim().replace(/^`+|`+$/g, "").replace(/^#+\s*/, "");
    if (!t || t.length > 200) return false;
    // A path-ish token: has a slash or a file extension, no spaces in the core.
    return /^[\w./\-@ ]+\.[A-Za-z0-9]+$/.test(t) || /\//.test(t);
  };

  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_SEARCH.test(line.trim())) {
      // Walk backwards (skipping blank / fence lines) to find the path.
      let p = pendingPath;
      for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
        const cand = lines[j].trim();
        if (!cand) continue;
        if (cand.startsWith("```")) {
          const after = cand.replace(/^```+\s*\w*\s*/, "").trim();
          if (after && looksLikePath(after)) {
            p = after;
            break;
          }
          continue;
        }
        if (looksLikePath(cand)) {
          p = cand.replace(/^`+|`+$/g, "").replace(/^#+\s*/, "").trim();
          break;
        }
        break;
      }

      // Collect SEARCH lines until the divider.
      i++;
      const search: string[] = [];
      while (i < lines.length && !FENCE_DIVIDER.test(lines[i].trim())) {
        search.push(lines[i]);
        i++;
      }
      i++; // skip divider
      const replace: string[] = [];
      while (i < lines.length && !FENCE_REPLACE.test(lines[i].trim())) {
        replace.push(lines[i]);
        i++;
      }
      i++; // skip closing REPLACE fence
      if (p) {
        blocks.push({
          path: p,
          search: search.join("\n"),
          replace: replace.join("\n"),
        });
      }
      pendingPath = p; // subsequent blocks may target the same file
      continue;
    }
    // Track a bare path line so a block that omits it can inherit it.
    if (looksLikePath(line)) pendingPath = line.replace(/^`+|`+$/g, "").trim();
    i++;
  }
  return blocks;
}

/** Levenshtein-ratio similarity in [0,1] (1 = identical). Cheap, line-level. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const dist = levenshtein(a, b);
  const max = Math.max(a.length, b.length);
  return 1 - dist / max;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

const normalizeWs = (s: string): string =>
  s
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .join("\n")
    .trim();

/**
 * Find where `search` occurs in `content`, returning the [start,end) line range
 * and the strategy/confidence used, or null. Tries progressively looser matches.
 */
export function locateBlock(
  content: string,
  search: string
): { start: number; end: number; strategy: MatchStrategy; confidence: number } | null {
  const contentLines = content.split("\n");
  const searchLines = search.split("\n");
  const win = searchLines.length;
  if (win === 0) return null;

  // 1. Exact contiguous match.
  for (let i = 0; i + win <= contentLines.length; i++) {
    if (contentLines.slice(i, i + win).join("\n") === search) {
      return { start: i, end: i + win, strategy: "exact", confidence: 1 };
    }
  }

  // 2. Whitespace-normalised match.
  const nSearch = normalizeWs(search);
  for (let i = 0; i + win <= contentLines.length; i++) {
    if (normalizeWs(contentLines.slice(i, i + win).join("\n")) === nSearch) {
      return { start: i, end: i + win, strategy: "whitespace", confidence: 0.97 };
    }
  }

  // 3. Anchored fuzzy match: the first and last non-blank search lines must
  //    appear (normalised); score the window between them by similarity.
  const firstAnchor = searchLines.find((l) => l.trim());
  const lastAnchor = [...searchLines].reverse().find((l) => l.trim());
  if (firstAnchor && lastAnchor) {
    const fa = firstAnchor.trim();
    const la = lastAnchor.trim();
    let best: { start: number; end: number; score: number } | null = null;
    for (let i = 0; i < contentLines.length; i++) {
      if (contentLines[i].trim() !== fa) continue;
      // Find the matching last-anchor within a reasonable span.
      const maxEnd = Math.min(contentLines.length, i + win + 6);
      for (let k = i + 1; k <= maxEnd; k++) {
        if (contentLines[k - 1].trim() !== la) continue;
        const score = similarity(
          normalizeWs(contentLines.slice(i, k).join("\n")),
          nSearch
        );
        if (!best || score > best.score) best = { start: i, end: k, score };
      }
    }
    if (best && best.score >= 0.75) {
      return { start: best.start, end: best.end, strategy: "anchored-fuzzy", confidence: best.score };
    }
  }

  return null;
}

/** Detect the common leading-indent of a block of lines (spaces or tabs). */
function commonIndent(lines: string[]): string {
  const nonBlank = lines.filter((l) => l.trim());
  if (!nonBlank.length) return "";
  let indent = nonBlank[0].match(/^[ \t]*/)?.[0] ?? "";
  for (const l of nonBlank.slice(1)) {
    const cur = l.match(/^[ \t]*/)?.[0] ?? "";
    let k = 0;
    while (k < indent.length && k < cur.length && indent[k] === cur[k]) k++;
    indent = indent.slice(0, k);
  }
  return indent;
}

/** Re-indent `replace` so its base indent matches the region it replaces. */
function reindent(replace: string, targetIndent: string, searchIndent: string): string {
  if (targetIndent === searchIndent) return replace;
  return replace
    .split("\n")
    .map((l) => {
      if (!l.trim()) return l;
      // Strip the replacement's own base indent, then prefix the target's.
      const stripped = l.startsWith(searchIndent) ? l.slice(searchIndent.length) : l.replace(/^[ \t]*/, "");
      return targetIndent + stripped;
    })
    .join("\n");
}

/** Apply a single edit block to in-memory content. Pure — no filesystem. */
export function applyBlockToContent(
  content: string,
  block: EditBlock
): { ok: boolean; result?: string; strategy: MatchStrategy; confidence: number; error?: string } {
  // Empty SEARCH ⇒ append (or full content if file is empty).
  if (!block.search.trim()) {
    const sep = content && !content.endsWith("\n") ? "\n" : "";
    return {
      ok: true,
      result: content ? content + sep + block.replace : block.replace,
      strategy: content ? "appended" : "created",
      confidence: 1,
    };
  }

  const loc = locateBlock(content, block.search);
  if (!loc) {
    return { ok: false, strategy: "exact", confidence: 0, error: "SEARCH block not found in file" };
  }

  const contentLines = content.split("\n");
  const region = contentLines.slice(loc.start, loc.end);
  const targetIndent = commonIndent(region);
  const searchIndent = commonIndent(block.search.split("\n"));
  let replacement = block.replace;
  let strategy = loc.strategy;
  if (loc.strategy !== "exact" && targetIndent !== searchIndent) {
    replacement = reindent(block.replace, targetIndent, searchIndent);
    strategy = "reindented";
  }

  const out = [
    ...contentLines.slice(0, loc.start),
    ...replacement.split("\n"),
    ...contentLines.slice(loc.end),
  ].join("\n");

  return { ok: true, result: out, strategy, confidence: loc.confidence };
}

/**
 * Apply edit blocks to the filesystem (grouped by file, applied in order),
 * journaling pre-images so a batch can be rolled back. Resolver maps a relative
 * path to an absolute one and enforces the write sandbox.
 */
export function applyEditBlocks(
  blocks: EditBlock[],
  resolve: (rel: string) => string
): BlockApplyResult[] {
  const results: BlockApplyResult[] = [];
  // Group consecutive blocks per file so multiple edits compose on live content.
  const byFile = new Map<string, EditBlock[]>();
  for (const b of blocks) {
    if (!byFile.has(b.path)) byFile.set(b.path, []);
    byFile.get(b.path)!.push(b);
  }

  for (const [rel, fileBlocks] of byFile) {
    let abs: string;
    try {
      abs = resolve(rel);
    } catch (err) {
      results.push({ path: rel, ok: false, before: null, error: (err as Error).message });
      continue;
    }
    const existed = fs.existsSync(abs);
    const before = existed ? fs.readFileSync(abs, "utf-8") : null;
    let content = before ?? "";
    let allOk = true;
    let lastStrategy: MatchStrategy = "exact";
    let lastConfidence = 1;

    for (const block of fileBlocks) {
      const r = applyBlockToContent(content, block);
      if (!r.ok) {
        results.push({
          path: rel,
          ok: false,
          before,
          strategy: r.strategy,
          confidence: r.confidence,
          error: r.error,
        });
        allOk = false;
        break;
      }
      content = r.result!;
      lastStrategy = r.strategy;
      lastConfidence = r.confidence;
    }

    if (!allOk) continue;

    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf-8");
      results.push({
        path: rel,
        ok: true,
        before,
        after: content,
        strategy: lastStrategy,
        confidence: lastConfidence,
      });
    } catch (err) {
      results.push({ path: rel, ok: false, before, error: (err as Error).message });
    }
  }

  return results;
}

/**
 * Produce targeted feedback for blocks that failed to match, so the model can
 * correct on the next turn. Includes the closest line in the file (by anchor
 * similarity) to nudge it toward the right region without dumping the whole file.
 */
export function explainFailure(content: string, block: EditBlock): string {
  const searchLines = block.search.split("\n").filter((l) => l.trim());
  if (!searchLines.length) return "SEARCH block was empty.";
  const anchor = searchLines[0].trim();
  const contentLines = content.split("\n");
  let bestLine = -1;
  let bestScore = 0;
  for (let i = 0; i < contentLines.length; i++) {
    const sc = similarity(contentLines[i].trim(), anchor);
    if (sc > bestScore) {
      bestScore = sc;
      bestLine = i;
    }
  }
  const hint =
    bestLine >= 0 && bestScore > 0.5
      ? ` Closest line in the file is L${bestLine + 1}: "${contentLines[bestLine].trim().slice(0, 120)}". ` +
        `Your SEARCH must match the file EXACTLY (copy it verbatim).`
      : ` No similar line found — the file may not contain that code at all.`;
  return `SEARCH block did not match ${block.path}.${hint}`;
}
