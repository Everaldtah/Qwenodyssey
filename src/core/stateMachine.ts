/**
 * Minimal pipeline state machine + trace. Mirrors the Odysseus-style
 * step-by-step task execution so runs are inspectable.
 */
export type Stage =
  | "intent"
  | "scan"
  | "plan"
  | "context"
  | "code"
  | "patch"
  | "review"
  | "test"
  | "fix"
  | "summary"
  | "done";

export const PIPELINE: Stage[] = [
  "intent",
  "scan",
  "plan",
  "context",
  "code",
  "patch",
  "review",
  "test",
  "fix",
  "summary",
  "done",
];

export interface TraceEntry {
  stage: Stage;
  at: string;
  note?: string;
}

export class StateMachine {
  private _stage: Stage = "intent";
  readonly trace: TraceEntry[] = [];

  get stage(): Stage {
    return this._stage;
  }

  enter(stage: Stage, note?: string): void {
    this._stage = stage;
    this.trace.push({ stage, at: new Date().toISOString(), note });
  }
}
