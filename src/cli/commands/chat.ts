import * as fs from "fs";
import * as readline from "readline";
import chalk from "chalk";
import { createSession, GlobalOpts } from "../session";
import { loadPrompt } from "../../core/promptLoader";
import { scanRepo, summarizeRepo } from "../../core/repoScanner";
import { resolveInside } from "../../tools/fileTools";
import { classifyCommand } from "../../tools/shellTools";
import { ToolRegistry } from "../../tools/registry";
import { banner, hrule } from "../render";
import { CHAT_TOOL_SPECS } from "../chatTools";
import type { Message, ModelInfo, ToolCall, ToolContext } from "../../types";
import type { Session } from "../session";

/** Hard cap on tool calls per user turn, to stop runaway loops. */
const MAX_TOOL_STEPS = 8;

/** Tool turns run deterministically; temp 0 markedly improves tool adherence. */
const TOOL_TEMP = 0;

/** Appended to the base system prompt so the model knows it can really act. */
const TOOL_SYSTEM = `
You are running inside a real terminal on the user's machine and have ACTUAL tools.
You are NOT simulating. To do anything in the real world — check the OS, wifi/network
status, run tests, inspect git, read or edit files, list processes, install packages —
you MUST call the appropriate tool (e.g. run_shell) rather than describing the command.
Never say you "cannot execute commands" or offer to "simulate": just call the tool.

CRITICAL: Writing a command inside a \`\`\` code fence does NOTHING — fenced code is
never executed and the user sees no result. The ONLY way to run something is to make a
run_shell tool call. Do not narrate ("I will run...", "let me execute...") and then stop;
make the tool call in the same turn. For multi-step tasks, call one tool, wait for its
real output, then call the next tool. When you have enough information, give a short final
answer with NO code fences.

Example — user: "what OS am I on?"  ✓ correct: call run_shell {command:"systeminfo"}.
✗ wrong: replying with \`\`\`powershell\\nsysteminfo\\n\`\`\` as text.

This machine runs Windows; the shell for run_shell is PowerShell/cmd, so prefer Windows
commands (e.g. 'netsh wlan show interfaces' for wifi, 'dir', 'Get-Process').`;

/**
 * Interactive pair-coding chat. Streams responses. Type @path to inline a
 * file's contents, /reset to clear history, /exit to quit.
 */
export async function chatCommand(opts: GlobalOpts): Promise<void> {
  const s = createSession(opts);
  const health = await s.provider.healthCheck();
  if (!health.ok) {
    console.log(chalk.red(`Model backend not reachable: ${health.detail}`));
    process.exitCode = 1;
    return;
  }

  const repo = await scanRepo(s.cwd);
  const history: Message[] = [
    {
      role: "system",
      content: loadPrompt("system") + "\n" + TOOL_SYSTEM + "\n\nPROJECT:\n" + summarizeRepo(repo),
    },
  ];

  console.log(
    banner({
      version: "0.1.0",
      model: s.provider.model,
      provider: s.provider.name,
      mode: s.mode,
      cwd: s.cwd,
    })
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  // Draw a box around the input: a rule above, the `❯` prompt line (where the
  // cursor sits and the user types), and a rule below once they hit Enter.
  // Resolve to /exit if stdin closes (Ctrl-D / EOF) so we quit cleanly.
  const ask = () =>
    new Promise<string>((resolve) => {
      if (closed) return resolve("/exit");
      process.stdout.write(hrule() + "\n");
      rl.question(chalk.cyan("❯ "), (answer) => {
        process.stdout.write(hrule() + "\n\n");
        resolve(answer);
      });
    });

  // Dedicated tool registry for chat. autoConfirm is true here because we run
  // our OWN confirmation gate (below) to avoid two stdin readers fighting over
  // the terminal; the hard-block list inside run_shell still applies regardless.
  const toolCtx: ToolContext = {
    cwd: s.cwd,
    autoConfirm: true,
    confirmDestructive: false,
    allowShell: s.config.tools.allow_shell,
    sandbox: s.config.tools.sandbox,
    log: (entry) => s.logger.event(entry),
  };
  const chatTools = new ToolRegistry(toolCtx);

  // Cached result of the last /models listing, so /model <#> can resolve indexes.
  let lastModels: ModelInfo[] = [];

  for (;;) {
    const line = (await ask()).trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/reset") {
      history.length = 1;
      console.log(chalk.gray("(history cleared)\n"));
      continue;
    }
    if (line === "/help" || line === "/?") {
      console.log(
        chalk.gray(
          "Qwenodyssey can run real shell/file/git commands to answer you.\n" +
            "Tools: run_shell, read_file, write_file, list_files, tree, grep, git_status, git_diff\n\n" +
            "Commands:\n" +
            "  /models           list installed models\n" +
            "  /model <name|#>   switch the active model\n" +
            "  @path             inline a file's contents\n" +
            "  /reset            clear conversation history\n" +
            "  /exit             quit\n"
        )
      );
      continue;
    }
    if (line === "/models" || line.startsWith("/model ") || line.startsWith("/models ")) {
      lastModels = await handleModels(s, line, lastModels);
      continue;
    }

    const expanded = expandFileRefs(line, s.cwd);
    history.push({ role: "user", content: expanded });

    try {
      await runAssistantTurn(s, chatTools, history, ask);
    } catch (err) {
      console.log(chalk.red(`\n[error: ${(err as Error).message}]`));
    }
  }
  rl.close();
}

/**
 * One user turn: let the model call tools (run_shell, read_file, …) in a loop,
 * feeding each tool's real output back, until it produces a final text answer.
 *
 * Small models sometimes regress and "describe" a command in a ``` fence instead
 * of emitting a native tool call. We (1) run tool turns at temperature 0 for
 * determinism, (2) inject a one-time corrective nudge when that happens, and
 * (3) if it still regresses, execute the shell-tagged command ourselves so the
 * user always gets a real result.
 */
async function runAssistantTurn(
  s: Session,
  tools: ToolRegistry,
  history: Message[],
  ask: () => Promise<string>
): Promise<void> {
  let nudged = false;

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const res = await s.provider.generate(history, {
      temperature: TOOL_TEMP,
      tools: CHAT_TOOL_SPECS,
    });
    const calls = res.toolCalls ?? [];

    // Happy path: the model made real tool calls.
    if (calls.length > 0) {
      history.push({ role: "assistant", content: res.text || "", tool_calls: calls });
      for (const call of calls) {
        const result = await executeToolCall(s, tools, call, ask);
        history.push({ role: "tool", tool_call_id: call.id, name: call.name, content: result });
      }
      continue;
    }

    // No tool call. Did it instead describe a runnable shell command in a fence?
    const fencedCmds = extractShellCommands(res.text);

    if (fencedCmds.length === 0) {
      // Genuine final answer.
      console.log(chalk.green("qwen › ") + (res.text.trim() || "(no response)") + "\n");
      history.push({ role: "assistant", content: res.text });
      return;
    }

    if (!nudged) {
      // First regression: correct it without running anything yet.
      nudged = true;
      history.push({
        role: "user",
        content:
          "[system] Do not print commands inside ``` code fences — fenced code is NOT executed " +
          "and the user sees no result. To actually run a command, call the run_shell tool. " +
          "If you already have what you need, give your final answer with no code fences.",
      });
      continue;
    }

    // Still regressing after a nudge: honour the obvious intent and run it.
    console.log(chalk.gray("  (model described a command instead of calling the tool — running it)"));
    const synthetic: ToolCall[] = fencedCmds.map((command, i) => ({
      id: `auto_${step}_${i}`,
      name: "run_shell",
      arguments: { command },
    }));
    history.push({ role: "assistant", content: "", tool_calls: synthetic });
    for (const call of synthetic) {
      const result = await executeToolCall(s, tools, call, ask);
      history.push({ role: "tool", tool_call_id: call.id, name: call.name, content: result });
    }
  }

  console.log(chalk.yellow(`[stopped after ${MAX_TOOL_STEPS} tool steps]`) + "\n");
  history.push({
    role: "assistant",
    content: `Reached the ${MAX_TOOL_STEPS}-step tool limit for this turn.`,
  });
}

/** Languages whose fenced blocks we treat as runnable shell commands. */
const SHELL_LANGS = new Set([
  "sh", "bash", "shell", "zsh", "console", "terminal", "shell-session",
  "powershell", "pwsh", "ps", "ps1", "posh", "cmd", "bat", "dos", "batch",
]);

/**
 * Pull runnable commands out of shell-tagged ``` fences in a model reply,
 * stripping shell-prompt prefixes (`$ `, `PS C:\>`, `> `). Untagged or
 * non-shell fences are ignored so we never auto-run code the user wanted
 * written rather than executed.
 */
function extractShellCommands(text: string): string[] {
  const cmds: string[] = [];
  const fence = /```([\w-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const lang = (m[1] || "").toLowerCase();
    if (!SHELL_LANGS.has(lang)) continue;
    const body = m[2]
      .split("\n")
      .map((l) => l.replace(/^\s*(PS[^>]*>|\$|>|#)\s+/, "").replace(/\s+$/, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n")
      .trim();
    if (body) cmds.push(body);
  }
  return cmds;
}

/** Run a single tool call against the registry, with a confirm gate for shell. */
async function executeToolCall(
  s: Session,
  tools: ToolRegistry,
  call: ToolCall,
  ask: () => Promise<string>
): Promise<string> {
  const args = call.arguments ?? {};

  // Show what the model is doing.
  if (call.name === "run_shell") {
    const cmd = String(args.command ?? "").trim();
    console.log(chalk.gray("  $ ") + chalk.cyan(cmd));

    const cls = classifyCommand(cmd);
    if (cls === "destructive" && s.config.tools.confirm_destructive && !s.autoConfirm) {
      console.log(chalk.yellow("  ⚠ looks destructive — type 'y' to run, anything else to skip:"));
      const reply = (await ask()).trim().toLowerCase();
      if (!/^(y|yes)$/.test(reply)) {
        console.log(chalk.gray("  (declined)\n"));
        return "Declined by user.";
      }
    }
  } else {
    const summary = Object.entries(args)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    console.log(chalk.gray(`  ⚙ ${call.name} ${summary}`));
  }

  const result = await tools.run(call.name, args);
  const out = (result.output ?? "").toString();
  const shown = out.length > 4000 ? out.slice(0, 4000) + "\n…(truncated)" : out;
  if (shown.trim()) {
    console.log(chalk.gray(indent(shown)) + "\n");
  }
  return out.slice(0, 8000) || (result.ok ? "(ok, no output)" : "(failed, no output)");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => "  │ " + l)
    .join("\n");
}

/**
 * `/models` lists installed models; `/model <name|#>` switches the active one
 * for the rest of the session. Returns the model list so callers can cache it
 * for index-based switching.
 */
async function handleModels(
  s: Session,
  line: string,
  cached: ModelInfo[]
): Promise<ModelInfo[]> {
  if (!s.provider.listModels || !s.provider.setModel) {
    console.log(chalk.gray(`(model switching not supported for ${s.provider.name})\n`));
    return cached;
  }

  const parts = line.split(/\s+/).slice(1); // drop the /models|/model token
  const arg = parts.join(" ").trim();

  let models = cached;
  try {
    models = await s.provider.listModels();
  } catch (err) {
    console.log(chalk.red(`[could not list models: ${(err as Error).message}]\n`));
    return cached;
  }

  // No argument → just print the list.
  if (!arg) {
    if (!models.length) {
      console.log(chalk.gray("(no models installed — pull one with `ollama pull <name>`)\n"));
      return models;
    }
    console.log(chalk.bold(`Installed models (${s.provider.name}):`));
    models.forEach((m, i) => {
      const current = m.name === s.provider.model;
      const marker = current ? chalk.green("●") : chalk.gray("○");
      const size = m.size ? chalk.gray(`  ${m.size}`) : "";
      const label = current ? chalk.green(m.name) : m.name;
      console.log(`  ${marker} ${chalk.gray(String(i + 1).padStart(2))}  ${label}${size}`);
    });
    console.log(chalk.gray("\nSwitch with /model <name> or /model <number>\n"));
    return models;
  }

  // Argument given → resolve by 1-based index or by name and switch.
  let target: ModelInfo | undefined;
  const asIndex = Number(arg);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= models.length) {
    target = models[asIndex - 1];
  } else {
    target = models.find((m) => m.name === arg) || models.find((m) => m.name.startsWith(arg));
  }

  if (!target) {
    console.log(chalk.red(`[no installed model matches "${arg}"]`));
    console.log(chalk.gray("Run /models to see what's available.\n"));
    return models;
  }

  s.provider.setModel(target.name);
  console.log(chalk.green(`✓ switched to ${target.name}`) + chalk.gray(` (${s.provider.name})\n`));
  return models;
}

function expandFileRefs(line: string, cwd: string): string {
  return line.replace(/@(\S+)/g, (match, p) => {
    try {
      const abs = resolveInside(cwd, p);
      if (fs.existsSync(abs)) {
        const content = fs.readFileSync(abs, "utf-8").slice(0, 6000);
        return `\n\n[file ${p}]\n\`\`\`\n${content}\n\`\`\`\n`;
      }
    } catch {
      /* leave as-is */
    }
    return match;
  });
}
