/**
 * Patch engine: apply file edits as unified diffs / creates / rewrites, with a
 * rollback journal under .qwenodyssey/patches.
 */
import * as fs from "fs";
import * as path from "path";
import { applyPatch, createTwoFilesPatch } from "diff";
import type { FileEdit } from "../types";
import { workspacePath } from "./config";
import { resolveInside } from "../tools/fileTools";

export interface AppliedEdit {
  path: string;
  mode: string;
  before: string | null; // null = file did not exist
  ok: boolean;
  error?: string;
}

export interface ApplyOutcome {
  applied: AppliedEdit[];
  journalFile?: string;
  allOk: boolean;
}

/** Build a colorizable unified diff preview for a single edit (no writes). */
export function previewEdit(cwd: string, edit: FileEdit): string {
  const abs = resolveInside(cwd, edit.path);
  const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : "";
  if (edit.mode === "delete") {
    return createTwoFilesPatch(edit.path, "/dev/null", before, "", "", "");
  }
  if (edit.mode === "patch" && edit.diff) {
    return edit.diff;
  }
  const after = edit.content ?? "";
  return createTwoFilesPatch(edit.path, edit.path, before, after, "", "");
}

function applySingle(cwd: string, edit: FileEdit): AppliedEdit {
  const abs = resolveInside(cwd, edit.path);
  const existed = fs.existsSync(abs);
  const before = existed ? fs.readFileSync(abs, "utf-8") : null;

  try {
    if (edit.mode === "delete") {
      if (existed) fs.rmSync(abs);
      return { path: edit.path, mode: edit.mode, before, ok: true };
    }

    if (edit.mode === "patch") {
      if (!edit.diff) throw new Error("patch edit missing diff");
      const patched = applyPatch(before ?? "", edit.diff);
      if (patched === false) throw new Error("unified diff did not apply cleanly");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, patched, "utf-8");
      return { path: edit.path, mode: edit.mode, before, ok: true };
    }

    // create / rewrite
    if (edit.mode === "create" && existed) {
      throw new Error("create target already exists");
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, edit.content ?? "", "utf-8");
    return { path: edit.path, mode: edit.mode, before, ok: true };
  } catch (err) {
    return { path: edit.path, mode: edit.mode, before, ok: false, error: (err as Error).message };
  }
}

/** Apply a list of edits, journaling pre-images so the batch can be rolled back. */
export function applyEdits(cwd: string, edits: FileEdit[]): ApplyOutcome {
  const applied: AppliedEdit[] = [];
  for (const edit of edits) {
    applied.push(applySingle(cwd, edit));
  }
  const allOk = applied.every((a) => a.ok);

  const dir = path.join(workspacePath(cwd), "patches");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const journalFile = path.join(dir, `patch-${stamp}.json`);
  fs.writeFileSync(journalFile, JSON.stringify({ ts: new Date().toISOString(), applied }, null, 2), "utf-8");

  return { applied, journalFile, allOk };
}

/** Restore files to their pre-image from a journal file. */
export function rollback(cwd: string, journalFile: string): string[] {
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf-8"));
  const restored: string[] = [];
  for (const a of journal.applied as AppliedEdit[]) {
    const abs = resolveInside(cwd, a.path);
    if (a.before === null) {
      if (fs.existsSync(abs)) fs.rmSync(abs);
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, a.before, "utf-8");
    }
    restored.push(a.path);
  }
  return restored;
}

/** Find the most recent patch journal, if any. */
export function latestJournal(cwd: string): string | undefined {
  const dir = path.join(workspacePath(cwd), "patches");
  if (!fs.existsSync(dir)) return undefined;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("patch-") && f.endsWith(".json"))
    .sort();
  return files.length ? path.join(dir, files[files.length - 1]) : undefined;
}
