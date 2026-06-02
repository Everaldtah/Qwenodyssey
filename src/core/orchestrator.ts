/**
 * The Qwenodyssey pipeline:
 *   scan → plan → context → code → patch → review → test → fix loop → summary
 *
 * Modes tune which stages run (see AgentMode).
 */
import chalk from "chalk";
import prompts from "prompts";
import type { AgentMode, FileEdit, Plan, Provider, RepoInfo } from "../types";
import type { Config } from "./config";
import { Logger } from "./logger";
import { ToolRegistry } from "../tools/registry";
import { scanRepo } from "./repoScanner";
import { buildContext, guessRelevantFiles } from "./contextBuilder";
import { applyEdits, previewEdit, rollback } from "./patchEngine";
import { colorizeDiff } from "../cli/render";
import { plan as planAgent } from "../agents/planner";
import { code as codeAgent } from "../agents/coder";
import { review as reviewAgent } from "../agents/reviewer";
import { runTests } from "../agents/tester";
import { fixErrors } from "../agents/errorFixer";
import { MemoryStore } from "../agents/memory";

export interface RunOptions {
  mode: AgentMode;
  autoConfirm: boolean;
}

export interface RunResult {
  edits: FileEdit[];
  applied: boolean;
  testsPassed?: boolean;
  summary: string;
}

export class Orchestrator {
  constructor(
    private cwd: string,
    private provider: Provider,
    private config: Config,
    private tools: ToolRegistry,
    private log: Logger,
    private memory: MemoryStore
  ) {}

  async runCode(task: string, opts: RunOptions): Promise<RunResult> {
    const { mode, autoConfirm } = opts;
    this.log.start(task);
    this.log.event({ type: "task", task, mode });

    // 1. Scan
    this.log.step("Scanning repo…");
    const repo = await scanRepo(this.cwd);
    this.log.debug(JSON.stringify(repo));
    this.log.event({ type: "scan", repo });

    if (repo.dirty) {
      this.log.warn("Working tree has uncommitted changes — commit or stash first if you want clean rollback points.");
    }

    // 2. Plan (skipped in fast mode)
    let plan: Plan;
    const fileList = await this.tools.run("list_files", { pattern: "**/*" });
    const files = (fileList.data as string[]) ?? [];
    if (mode === "fast") {
      plan = { goal: task, steps: [{ index: 1, title: task, detail: task }], files: [] };
    } else {
      this.log.step("Planning…");
      plan = await planAgent(this.provider, task, repo, files);
      this.printPlan(plan, repo);
      this.log.event({ type: "plan", plan });

      if (mode !== "deep" && !autoConfirm) {
        const { go } = await prompts({ type: "confirm", name: "go", message: "Proceed with this plan?", initial: true });
        if (!go) return { edits: [], applied: false, summary: "Aborted by user at plan stage." };
      }
    }

    // 3. Context
    const relevant =
      plan.files.length > 0 ? plan.files : guessRelevantFiles(repo, task);
    const gitDiff = repo.hasGit ? (await this.tools.run("git_diff", {})).output : undefined;
    const context = buildContext(this.provider, {
      userRequest: task,
      repo,
      files: relevant,
      gitDiff,
      memory: this.config.memory.enabled ? this.memory.digest() : undefined,
      budgetTokens: Math.floor(this.config.model.context_tokens * 0.6),
    });

    // 4. Code
    this.log.step("Generating edits…");
    const coderOut = await codeAgent(this.provider, task, plan, context);
    if (coderOut.edits.length === 0) {
      return { edits: [], applied: false, summary: "Model produced no edits. Try rephrasing or use --deep." };
    }
    this.log.event({ type: "code", edits: coderOut.edits.map((e) => ({ path: e.path, mode: e.mode })) });
    this.showEdits(coderOut.edits);

    // 5. Review (safe/deep)
    if ((mode === "safe" || mode === "deep") && this.config.agent.review_before_apply) {
      this.log.step("Reviewing…");
      const review = await reviewAgent(this.provider, this.cwd, task, coderOut.edits);
      this.printReview(review);
      this.log.event({ type: "review", review });
      if (!review.approve && !autoConfirm) {
        const { go } = await prompts({ type: "confirm", name: "go", message: "Reviewer flagged issues. Apply anyway?", initial: false });
        if (!go) return { edits: coderOut.edits, applied: false, summary: "Held back after review." };
      }
    }

    // 6. Apply (with confirmation unless auto)
    const shouldApply =
      autoConfirm || this.config.agent.auto_apply || (await this.confirmApply());
    if (!shouldApply) {
      return { edits: coderOut.edits, applied: false, summary: "Edits generated but not applied. Re-run with --yes or `qwenodyssey apply`." };
    }

    let outcome = applyEdits(this.cwd, coderOut.edits);
    this.reportApply(outcome.applied);
    this.log.event({ type: "apply", journal: outcome.journalFile, ok: outcome.allOk });

    // 7. Test + fix loop (deep / autofix-ish; safe runs once)
    let testsPassed: boolean | undefined;
    const wantTests = this.config.agent.auto_test && (mode === "safe" || mode === "deep");
    if (wantTests) {
      testsPassed = await this.testAndFixLoop(task, repo, mode);
    }

    // 8. Summary
    const summary = await this.summarize(task, coderOut.edits, testsPassed);
    this.log.event({ type: "summary", summary, testsPassed });
    return { edits: coderOut.edits, applied: true, testsPassed, summary };
  }

  /** --autofix: run tests, diagnose failures, patch, repeat. No initial codegen. */
  async runAutofix(task: string): Promise<RunResult> {
    const goal = task && task.trim() ? task : "Make the failing tests pass.";
    this.log.start(`autofix: ${goal}`);
    this.log.step("Scanning repo…");
    const repo = await scanRepo(this.cwd);
    if (!repo.testCommand) {
      return { edits: [], applied: false, summary: "No test command detected; nothing to autofix." };
    }
    const passed = await this.testAndFixLoop(goal, repo, "deep");
    const summary = passed
      ? "Autofix succeeded: tests now pass."
      : "Autofix could not get tests passing within the retry budget.";
    return { edits: [], applied: true, testsPassed: passed, summary };
  }

  private async testAndFixLoop(task: string, repo: RepoInfo, mode: AgentMode): Promise<boolean> {
    const maxRetries = mode === "deep" ? this.config.agent.max_retries : 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      this.log.step(attempt === 0 ? "Running tests…" : `Re-running tests (attempt ${attempt})…`);
      const result = await runTests(this.tools, repo);
      this.log.event({ type: "test", attempt, ran: result.ran, passed: result.passed });
      if (!result.ran) {
        this.log.warn(result.output);
        return false;
      }
      if (result.passed) {
        this.log.success("Tests passed.");
        return true;
      }
      this.log.error("Tests failed.");
      if (attempt >= maxRetries) {
        this.log.warn(`Giving up after ${maxRetries + 1} attempt(s).`);
        return false;
      }
      // Fix loop
      this.log.step("Analyzing failure and patching…");
      const relevant = guessRelevantFiles(repo, task);
      const context = buildContext(this.provider, {
        userRequest: task,
        repo,
        files: relevant,
        errors: result.output,
        budgetTokens: Math.floor(this.config.model.context_tokens * 0.6),
      });
      const fix = await fixErrors(this.provider, task, result.output, context);
      if (fix.edits.length === 0) {
        this.log.warn("No fix proposed.");
        return false;
      }
      this.showEdits(fix.edits);
      const outcome = applyEdits(this.cwd, fix.edits);
      this.reportApply(outcome.applied);
      this.log.event({ type: "fix_apply", attempt, journal: outcome.journalFile });
    }
    return false;
  }

  private async summarize(task: string, edits: FileEdit[], testsPassed?: boolean): Promise<string> {
    try {
      const { loadPrompt, render } = await import("./promptLoader");
      const prompt = render(loadPrompt("summarizer"), {
        task,
        edits: edits.map((e) => `${e.mode} ${e.path}`).join("\n"),
        tests: testsPassed === undefined ? "not run" : testsPassed ? "passed" : "failed",
      });
      const res = await this.provider.generate(
        [
          { role: "system", content: loadPrompt("system") },
          { role: "user", content: prompt },
        ],
        { temperature: 0.2, max_tokens: 400 }
      );
      return res.text.trim();
    } catch {
      return `Applied ${edits.length} edit(s).`;
    }
  }

  /* ── UI helpers ── */

  private printPlan(plan: Plan, repo: RepoInfo): void {
    console.log(chalk.bold("\nProposed plan: ") + chalk.gray(plan.goal));
    if (plan.files.length) console.log(chalk.bold("Files likely needed:"));
    plan.files.forEach((f) => console.log("  - " + f));
    console.log(chalk.bold("Steps:"));
    plan.steps.forEach((s) => console.log(`  ${s.index}. ${s.title}` + (s.detail ? chalk.gray(` — ${s.detail}`) : "")));
    if (plan.assumptions?.length) {
      console.log(chalk.yellow("Assumptions:"));
      plan.assumptions.forEach((a) => console.log("  · " + a));
    }
    console.log();
  }

  private showEdits(edits: FileEdit[]): void {
    for (const e of edits) {
      console.log(chalk.bold(`\n${e.mode.toUpperCase()} ${e.path}`) + (e.rationale ? chalk.gray(` — ${e.rationale}`) : ""));
      console.log(colorizeDiff(previewEdit(this.cwd, e)));
    }
  }

  private printReview(review: { approve: boolean; summary?: string; issues: any[] }): void {
    console.log(chalk.bold("\nReview: ") + (review.approve ? chalk.green("approved") : chalk.red("changes suggested")) + (review.summary ? chalk.gray(` — ${review.summary}`) : ""));
    for (const i of review.issues) {
      const tag = i.severity === "error" ? chalk.red("error") : i.severity === "warning" ? chalk.yellow("warn") : chalk.gray("info");
      console.log(`  [${tag}] ${i.file ? i.file + ": " : ""}${i.message}`);
    }
  }

  private reportApply(applied: { path: string; mode: string; ok: boolean; error?: string }[]): void {
    for (const a of applied) {
      if (a.ok) this.log.success(`${a.mode} ${a.path}`);
      else this.log.error(`${a.mode} ${a.path} — ${a.error}`);
    }
  }

  private async confirmApply(): Promise<boolean> {
    const { go } = await prompts({ type: "confirm", name: "go", message: "Apply these edits?", initial: true });
    return !!go;
  }
}
