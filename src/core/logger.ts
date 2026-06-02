/**
 * Console + structured JSONL session logging.
 */
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { workspacePath } from "./config";

export class Logger {
  private file?: string;
  public verbose = false;

  constructor(private cwd: string, opts: { verbose?: boolean } = {}) {
    this.verbose = !!opts.verbose;
  }

  /** Begin a session log file under .qwenodyssey/logs. */
  start(task: string): void {
    const dir = path.join(workspacePath(this.cwd), "logs");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..+/, "")
      .replace("T", "-");
    this.file = path.join(dir, `session-${stamp}.jsonl`);
    this.event({ type: "session_start", task });
  }

  /** Append a structured event to the session log (if started). */
  event(entry: Record<string, unknown>): void {
    if (!this.file) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    try {
      fs.appendFileSync(this.file, line + "\n", "utf-8");
    } catch {
      /* logging must never crash the run */
    }
  }

  info(msg: string): void {
    console.log(msg);
  }
  step(msg: string): void {
    console.log(chalk.cyan("→ ") + msg);
  }
  success(msg: string): void {
    console.log(chalk.green("✓ ") + msg);
  }
  warn(msg: string): void {
    console.log(chalk.yellow("! ") + msg);
  }
  error(msg: string): void {
    console.log(chalk.red("✗ ") + msg);
  }
  debug(msg: string): void {
    if (this.verbose) console.log(chalk.gray("· " + msg));
  }

  get logFile(): string | undefined {
    return this.file;
  }
}
