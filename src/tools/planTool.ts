/**
 * In-session plan / TODO tracking. Gives the model an `update_plan` tool so it
 * can lay out the steps of a multi-step task and keep their status current as it
 * works — which markedly improves a small model's coherence over long tool
 * chains (it stops "losing the thread"). The current plan is also shown by the
 * /plan chat command.
 *
 * Clean-room implementation — inspired by the to-do/checklist tool in
 * Claude-Code-class agents, written from scratch for Qwenodyssey.
 */
import type { Tool } from "../types";

export type PlanStatus = "pending" | "in_progress" | "done";
export interface PlanItem {
  step: string;
  status: PlanStatus;
}
/** Shared, mutable holder so chat can render the latest plan on demand. */
export interface PlanState {
  items: PlanItem[];
}

const MARK: Record<PlanStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  done: "[x]",
};

export function renderPlan(items: PlanItem[]): string {
  if (!items.length) return "(no plan yet)";
  return items.map((it, i) => `${MARK[it.status]} ${i + 1}. ${it.step}`).join("\n");
}

function coerce(raw: unknown): PlanItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((it: any) => {
      const step = String((it && (it.step ?? it.title ?? it.task)) ?? it ?? "").trim();
      const st = String(it && it.status || "pending").toLowerCase();
      const status: PlanStatus = st === "done" || st === "completed" ? "done" : st === "in_progress" || st === "active" ? "in_progress" : "pending";
      return { step, status };
    })
    .filter((i) => i.step);
}

export function createPlanTool(state: PlanState): Tool {
  return {
    name: "update_plan",
    description:
      "Create or update your step-by-step plan for a multi-step task and keep each step's status " +
      "current as you work. Pass the FULL plan each time (the list is replaced).",
    mutating: false,
    async run(args, ctx) {
      const items = coerce(args.plan ?? args.steps ?? args.todos);
      if (!items.length) {
        return { ok: false, output: "Provide `plan` as a non-empty array of { step, status }." };
      }
      // Encourage exactly one in-progress step (gentle normalisation, not enforced hard).
      state.items = items;
      ctx.log({ tool: "update_plan", steps: items.length });
      return { ok: true, output: "Plan updated:\n" + renderPlan(items) };
    },
  };
}
