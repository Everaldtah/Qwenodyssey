/**
 * Best-of-N candidate selection.
 *
 * A single sample from a 7B–20B model on a coding task has a meaningful failure
 * rate. Sampling several candidates (at modest temperature) and selecting the
 * best by an OBJECTIVE signal — does it parse? does it apply? does it typecheck?
 * do tests pass? — recovers a large fraction of that gap, because the failures
 * are largely independent. This is the cheapest reliability win after structured
 * editing, and it's why this harness can make a small model feel far steadier.
 *
 * The scorer is pluggable so callers grade candidates with whatever signal they
 * have (a pure parse check, an apply-dry-run, or a full verify pass).
 */

export interface Candidate<T> {
  value: T;
  /** Raw model text the candidate was parsed from (for debugging). */
  raw: string;
  index: number;
}

export interface ScoredCandidate<T> extends Candidate<T> {
  score: number;
  /** Human-readable reason for the score (e.g. "typechecks; 2 tests fail"). */
  reason: string;
}

export interface BestOfNOptions<T> {
  /** How many candidates to draw. */
  n: number;
  /** Draw a single candidate (caller controls temperature/seed via closure). */
  sample: (attempt: number) => Promise<{ value: T | null; raw: string }>;
  /**
   * Score a candidate. Higher is better. Return -Infinity to reject outright.
   * Async so it can run a real verify pass. May be called concurrently-safe
   * only if the caller's scorer is; we call it sequentially to be safe with
   * filesystem-mutating scorers (apply-dry-run, verify).
   */
  score: (value: T) => Promise<{ score: number; reason: string }>;
  /** Stop early once a candidate scores ≥ this (e.g. "all checks pass"). */
  earlyAcceptScore?: number;
  /** Called after each candidate is scored (for progress UI). */
  onProgress?: (attempt: number, scored: ScoredCandidate<T> | null) => void;
}

export interface BestOfNResult<T> {
  best: ScoredCandidate<T> | null;
  all: ScoredCandidate<T>[];
  /** True if we stopped early on an early-accept hit. */
  earlyAccepted: boolean;
}

/**
 * Draw up to N candidates, score each, and return the best. Sampling is
 * sequential by default (so a scorer that mutates the workspace and rolls back
 * is safe). Early-accept short-circuits as soon as a clearly-good candidate
 * appears, so the common case stays cheap.
 */
export async function bestOfN<T>(opts: BestOfNOptions<T>): Promise<BestOfNResult<T>> {
  const scored: ScoredCandidate<T>[] = [];
  let earlyAccepted = false;

  for (let i = 0; i < opts.n; i++) {
    let drawn: { value: T | null; raw: string };
    try {
      drawn = await opts.sample(i);
    } catch (err) {
      opts.onProgress?.(i, null);
      continue;
    }
    if (drawn.value == null) {
      opts.onProgress?.(i, null);
      continue;
    }

    let sc: { score: number; reason: string };
    try {
      sc = await opts.score(drawn.value);
    } catch (err) {
      sc = { score: -Infinity, reason: `scorer error: ${(err as Error).message}` };
    }

    const cand: ScoredCandidate<T> = {
      value: drawn.value,
      raw: drawn.raw,
      index: i,
      score: sc.score,
      reason: sc.reason,
    };
    if (Number.isFinite(cand.score)) scored.push(cand);
    opts.onProgress?.(i, cand);

    if (opts.earlyAcceptScore != null && cand.score >= opts.earlyAcceptScore) {
      earlyAccepted = true;
      break;
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return { best: scored[0] ?? null, all: scored, earlyAccepted };
}

/**
 * A standard scoring scale so different scorers compose consistently:
 *   100  all checks pass (tests + typecheck)
 *   80   typechecks/builds, no tests run or tests partially pass
 *   60   applies cleanly, parses, but checks fail
 *   40   parses/applies but has check errors
 *   10   parses only
 *   -Inf rejected (didn't parse / didn't apply)
 */
export const SCORE = {
  ALL_PASS: 100,
  COMPILES: 80,
  APPLIES: 60,
  PARSES: 10,
  REJECT: -Infinity,
} as const;
