/**
 * Reliable edit pipeline — the heart of the small-model coding uplift.
 *
 * Composes the building blocks into one robust flow:
 *
 *   generate (best-of-N edit-block candidates)
 *     → dry-run apply each candidate to scratch copies (reject non-applying)
 *     → apply the best to the real tree with a rollback snapshot
 *     → verify (typecheck / lint / test)
 *     → if verify fails, feed the digest back and self-repair (bounded)
 *     → on unrecoverable failure, roll back cleanly
 *
 * Each layer targets a specific small-model failure mode:
 *   - edit blocks       → unreliable unified diffs
 *   - best-of-N + apply  → single-sample variance
 *   - verify-in-the-loop → models that don't check their work
 *   - self-repair        → grounding the retry in real compiler/test output
 *   - rollback snapshot  → never leave the tree half-edited
 */
import * as fs from "fs";
import * as path from "path";
import {
  parseEditBlocks,
  applyBlockToContent,
  applyEditBlocks,
  type EditBlock,
  type BlockApplyResult,
} from "./editBlock";
import { bestOfN, SCORE, type ScoredCandidate } from "./candidateSelect";
import { verify, type VerifyOutcome } from "./verifyLoop";

export interface GenerateFn {
  /** Produce a model response (raw text) for the given attempt index. The
   * closure controls the prompt, temperature, and any feedback injection. */
  (attempt: number, feedback?: string): Promise<string>;
}

export interface EditPipelineOptions {
  root: string;
  /** Resolve a relative path to an absolute one, enforcing the write sandbox. */
  resolve: (rel: string) => string;
  /** How many candidates to sample per attempt (best-of-N). 1 disables it. */
  candidates: number;
  /** Max self-repair rounds after a failing verify. 0 disables repair. */
  maxRepairRounds: number;
  /** Run verification (typecheck/lint/test) after applying. */
  runVerify: boolean;
  /** Only run these check kinds during the inner loop (e.g. fast checks). */
  verifyOnly?: ("typecheck" | "lint" | "test" | "build")[];
  /** Progress hook for UI. */
  onEvent?: (e: PipelineEvent) => void;
}

export type PipelineEvent =
  | { type: "sampling"; attempt: number; candidate: number }
  | { type: "candidate-scored"; candidate: number; score: number; reason: string }
  | { type: "applied"; results: BlockApplyResult[] }
  | { type: "verifying" }
  | { type: "verify-result"; passed: boolean; feedback: string }
  | { type: "repairing"; round: number }
  | { type: "rolled-back"; reason: string };

export interface EditPipelineResult {
  applied: boolean;
  verified: boolean;
  blocks: EditBlock[];
  applyResults: BlockApplyResult[];
  verify?: VerifyOutcome;
  rounds: number;
  message: string;
}

/** Snapshot the files a set of blocks will touch, for clean rollback. */
function snapshot(blocks: EditBlock[], resolve: (rel: string) => string): Map<string, string | null> {
  const snap = new Map<string, string | null>();
  for (const b of blocks) {
    if (snap.has(b.path)) continue;
    try {
      const abs = resolve(b.path);
      snap.set(b.path, fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null);
    } catch {
      snap.set(b.path, null);
    }
  }
  return snap;
}

function restore(snap: Map<string, string | null>, resolve: (rel: string) => string): void {
  for (const [rel, content] of snap) {
    try {
      const abs = resolve(rel);
      if (content === null) {
        if (fs.existsSync(abs)) fs.rmSync(abs);
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf-8");
      }
    } catch {
      /* best-effort restore */
    }
  }
}

/**
 * Dry-run: would these blocks all apply to the current on-disk content? Pure —
 * no writes. Returns true plus per-block detail, or false with the first error.
 */
export function dryRunApply(
  blocks: EditBlock[],
  resolve: (rel: string) => string
): { ok: boolean; firstError?: string } {
  const liveContent = new Map<string, string>();
  for (const b of blocks) {
    let content = liveContent.get(b.path);
    if (content === undefined) {
      try {
        const abs = resolve(b.path);
        content = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : "";
      } catch (err) {
        return { ok: false, firstError: (err as Error).message };
      }
    }
    const r = applyBlockToContent(content, b);
    if (!r.ok) return { ok: false, firstError: `${b.path}: ${r.error}` };
    liveContent.set(b.path, r.result!);
  }
  return { ok: true };
}

/**
 * Run the full reliable edit pipeline. `generate` is called to produce model
 * output (edit blocks); it receives the attempt index and, on repair rounds,
 * the verify feedback to incorporate.
 */
export async function runEditPipeline(
  generate: GenerateFn,
  opts: EditPipelineOptions
): Promise<EditPipelineResult> {
  const emit = (e: PipelineEvent) => opts.onEvent?.(e);

  // ── Phase 1: best-of-N candidate generation, scored by "does it apply?" ──
  const selection = await bestOfN<EditBlock[]>({
    n: Math.max(1, opts.candidates),
    sample: async (attempt) => {
      emit({ type: "sampling", attempt: 0, candidate: attempt });
      const raw = await generate(attempt);
      const blocks = parseEditBlocks(raw);
      return { value: blocks.length ? blocks : null, raw };
    },
    score: async (blocks) => {
      const dry = dryRunApply(blocks, opts.resolve);
      if (!dry.ok) return { score: SCORE.REJECT, reason: dry.firstError ?? "did not apply" };
      // More blocks that apply cleanly is mild positive signal; ties broken later.
      return { score: SCORE.APPLIES + Math.min(blocks.length, 10), reason: `${blocks.length} block(s) apply` };
    },
    earlyAcceptScore: SCORE.APPLIES, // first applying candidate is good enough to try
    onProgress: (candidate, scored) => {
      if (scored) emit({ type: "candidate-scored", candidate, score: scored.score, reason: scored.reason });
    },
  });

  if (!selection.best) {
    return {
      applied: false,
      verified: false,
      blocks: [],
      applyResults: [],
      rounds: 0,
      message: "No candidate produced applicable edits. The model may need clearer instructions or the SEARCH text didn't match.",
    };
  }

  let blocks = selection.best.value;

  // ── Phase 2: apply with a rollback snapshot ──
  const snap = snapshot(blocks, opts.resolve);
  let applyResults = applyEditBlocks(blocks, opts.resolve);
  emit({ type: "applied", results: applyResults });

  if (!applyResults.every((r) => r.ok)) {
    restore(snap, opts.resolve);
    emit({ type: "rolled-back", reason: "apply failed" });
    const errs = applyResults.filter((r) => !r.ok).map((r) => `${r.path}: ${r.error}`).join("; ");
    return {
      applied: false,
      verified: false,
      blocks,
      applyResults,
      rounds: 0,
      message: `Edits failed to apply and were rolled back: ${errs}`,
    };
  }

  // ── Phase 3: verify + bounded self-repair ──
  if (!opts.runVerify) {
    return { applied: true, verified: false, blocks, applyResults, rounds: 0, message: "Edits applied (verification disabled)." };
  }

  let rounds = 0;
  let lastVerify: VerifyOutcome | undefined;
  for (let round = 0; round <= opts.maxRepairRounds; round++) {
    emit({ type: "verifying" });
    lastVerify = await verify(opts.root, { only: opts.verifyOnly, stopOnFirstFailure: true });
    emit({ type: "verify-result", passed: lastVerify.allPassed, feedback: lastVerify.feedback });

    if (lastVerify.allPassed || !lastVerify.ran) {
      return {
        applied: true,
        verified: lastVerify.allPassed,
        blocks,
        applyResults,
        verify: lastVerify,
        rounds,
        message: lastVerify.ran ? "Edits applied and verified." : "Edits applied (no checks detected).",
      };
    }

    if (round >= opts.maxRepairRounds) break;

    // Self-repair: regenerate with the failure digest as feedback.
    rounds++;
    emit({ type: "repairing", round: rounds });
    const raw = await generate(round + 1, lastVerify.feedback);
    const repairBlocks = parseEditBlocks(raw);
    if (!repairBlocks.length) break;

    const dry = dryRunApply(repairBlocks, opts.resolve);
    if (!dry.ok) continue; // bad repair; try another round if budget remains

    // Extend the snapshot to cover any newly-touched files, then apply.
    for (const [rel, content] of snapshot(repairBlocks, opts.resolve)) {
      if (!snap.has(rel)) snap.set(rel, content);
    }
    const repairResults = applyEditBlocks(repairBlocks, opts.resolve);
    if (repairResults.every((r) => r.ok)) {
      blocks = [...blocks, ...repairBlocks];
      applyResults = [...applyResults, ...repairResults];
    }
  }

  // Verification never passed within budget. Keep the edits but report honestly;
  // the caller decides whether to roll back (we don't force it — partial progress
  // is often useful, and the user has a rollback snapshot via the patch journal).
  return {
    applied: true,
    verified: false,
    blocks,
    applyResults,
    verify: lastVerify,
    rounds,
    message: `Edits applied but verification still fails after ${rounds} repair round(s):\n${lastVerify?.feedback ?? ""}`,
  };
}
