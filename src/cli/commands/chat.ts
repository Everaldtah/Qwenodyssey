import * as fs from "fs";
import chalk from "chalk";
import { createSession, GlobalOpts } from "../session";
import { loadPrompt } from "../../core/promptLoader";
import { scanRepo, summarizeRepo } from "../../core/repoScanner";
import { resolveInside } from "../../tools/fileTools";
import { classifyCommand } from "../../tools/shellTools";
import { ToolRegistry } from "../../tools/registry";
import { banner, hrule, Spinner, thinkingWord, formatTokens } from "../render";
import { CHAT_TOOL_SPECS, WEB_TOOL_SPECS, KNOWLEDGE_TOOL_SPECS } from "../chatTools";
import { createPrompt, SlashCommand } from "../prompt";
import { KnowledgeBase } from "../../core/knowledge";
import { createKnowledgeTools } from "../../tools/knowledgeTools";
import { createWebTools } from "../../tools/webTools";
import type { GenerateResult, Message, ModelInfo, ModelOptions, ToolCall, ToolContext, ToolSpec } from "../../types";
import type { Session } from "../session";

/** Hard cap on tool calls per user turn, to stop runaway loops. */
const MAX_TOOL_STEPS = 8;

/** Tool turns run deterministically; temp 0 markedly improves tool adherence. */
const TOOL_TEMP = 0;

/** Reasoning models (R1/QwQ) need a little heat or they loop; ~0.6 is recommended. */
const REASONING_TEMP = 0.6;

/** Models trained to deliberate with an internal chain-of-thought. */
function isReasoningModel(model: string): boolean {
  return /(^|[-_/:.])(r1|qwq|o1|o3|thinking|reason)/i.test(model) || /deepseek-r1/i.test(model);
}

/**
 * Encourages deliberate, step-by-step reasoning before answering or acting.
 * Compatible with tool use (reason first, then call a tool) and harmless for
 * native reasoning models, which already think on their own.
 */
const DEEP_THINK = `
THINK DEEPLY before you answer or act. Reason carefully about what the user
actually needs, consider edge cases and alternatives, and check your logic for
mistakes. For any non-trivial request, work through it step by step instead of
guessing, and prefer verifying with a tool over assuming. Only give your final
answer once you are confident it is correct and complete.`;

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
commands (e.g. 'netsh wlan show interfaces' for wifi, 'dir', 'Get-Process').

WORKING WITH PATHS THE USER NAMES: when the user references a directory or file —
especially an absolute path like "C:\\Projects\\Overstory" — operate on THAT path, not the
current directory. Pass it as the \`path\` argument: tree {path:"C:\\Projects\\Overstory"},
list_files {path:"...", pattern:"**/*.md"}, read_file {path:"...\\README.md"},
grep {path:"...", pattern:"..."}. These read-only tools can access any path on the machine,
so never claim a folder is out of reach — just target it.

ANALYSING A PROJECT (e.g. "explain what this project is about <path>"):
1. tree {path:<the path>, depth:2} to see the layout.
2. read the key files that explain it — README.md, package.json / pyproject.toml / Cargo.toml,
   and any docs/ or main entry file — with read_file {path:<full path>}.
3. THEN write the explanation from what you actually read.
A directory listing is NOT an analysis: do not stop after one tree/list and summarise the
file names — read the important files first, then explain the project's purpose, stack, and
structure. Keep calling tools until you genuinely understand it.`;

/** Teaches the model to use its long-term memory + the internet. */
const MEMORY_SYSTEM = `
You have LONG-TERM MEMORY (a personal knowledge vault) and INTERNET ACCESS.

Workflow for anything you're unsure about:
1. First call knowledge_search to recall what you already learned (it's also auto-recalled
   for you below when relevant).
2. If memory lacks it, use web_search then web_fetch to read the best source.
3. DISTILL what you learned and call knowledge_save to store it permanently — reuse an
   existing title to UPDATE/improve a note rather than duplicating. Cite source URLs.

Build deep, durable understanding: when you study a codebase, an API, an error, or a
concept, save the key facts so future sessions start smarter. Prefer your saved knowledge
over guessing, and correct/extend notes when you discover something better.`;

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

  // If the configured model isn't installed, fall back to fallback_model.
  await resolveStartupModel(s);

  const repo = await scanRepo(s.cwd);

  // Long-term knowledge vault (RAG memory). Created on first use.
  const kb = new KnowledgeBase(s.config.knowledge.path, {
    baseUrl: s.config.model.base_url,
    embedModel: s.config.knowledge.embed_model,
  });
  const memoryEnabled = s.config.knowledge.enabled;
  if (memoryEnabled) kb.ensure();

  let sys = loadPrompt("system") + "\n" + TOOL_SYSTEM + "\n" + DEEP_THINK;
  if (memoryEnabled || s.config.web.enabled) sys += "\n" + MEMORY_SYSTEM;
  sys += "\n\nPROJECT:\n" + summarizeRepo(repo);
  const history: Message[] = [{ role: "system", content: sys }];

  console.log(
    banner({
      version: "0.1.0",
      model: s.provider.model,
      provider: s.provider.name,
      mode: s.mode,
      cwd: s.cwd,
    })
  );

  // Interactive prompt with the live slash-command palette (TTY); falls back to
  // a plain line reader when stdin is piped. Wrapped in a rule "box": a rule
  // above, the `❯` input line (palette floats beneath it), a rule below on Enter.
  const prompt = createPrompt(chalk.cyan("❯ "), SLASH_COMMANDS);
  const ask = () =>
    new Promise<string>((resolve) => {
      process.stdout.write(hrule() + "\n");
      prompt.ask().then((answer) => {
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

  // Compose the tool set advertised to the model: shell/file/git always, plus
  // internet and long-term memory when enabled in config.
  const toolSpecs: ToolSpec[] = [...CHAT_TOOL_SPECS];
  if (s.config.web.enabled) {
    createWebTools({
      provider: s.config.web.provider,
      apiKey: s.config.web.api_key,
      searxngUrl: s.config.web.searxng_url,
      maxResults: s.config.web.max_results,
      fetchChars: s.config.web.fetch_chars,
    }).forEach((t) => chatTools.register(t));
    toolSpecs.push(...WEB_TOOL_SPECS);
  }
  if (memoryEnabled) {
    createKnowledgeTools(kb).forEach((t) => chatTools.register(t));
    toolSpecs.push(...KNOWLEDGE_TOOL_SPECS);
  }

  // Cached result of the last /models listing, so /model <#> can resolve indexes.
  let lastModels: ModelInfo[] = [];
  // Tracks real token usage and self-calibrates the live "↑ tokens" estimate.
  const meter = new TokenMeter();

  for (;;) {
    const line = (await ask()).trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/reset") {
      history.length = 1;
      console.log(chalk.gray("(history cleared)\n"));
      continue;
    }
    if (line === "/help" || line === "/?" || line === "/commands" || line === "/") {
      console.log(renderCommandMenu());
      continue;
    }
    if (line === "/settings" || line === "/config") {
      console.log(renderSettings(s, kb, memoryEnabled));
      continue;
    }
    if (line === "/memory" || line === "/knowledge") {
      console.log(renderMemory(kb, s, memoryEnabled));
      continue;
    }
    if (line === "/models" || line.startsWith("/model ") || line.startsWith("/models ")) {
      lastModels = await handleModels(s, line, lastModels);
      continue;
    }

    const expanded = expandFileRefs(line, s.cwd);

    // Auto-recall: pull relevant notes from long-term memory into context.
    if (memoryEnabled && s.config.knowledge.auto_recall) {
      const recalled = await recallKnowledge(kb, line, s.config.knowledge.recall_k);
      if (recalled) history.push({ role: "system", content: recalled });
    }

    history.push({ role: "user", content: expanded });

    try {
      await runAssistantTurn(s, chatTools, toolSpecs, history, meter, ask);
    } catch (err) {
      console.log(chalk.red(`\n[error: ${(err as Error).message}]`));
    }
  }
  prompt.close();
}

/** Retrieve top notes for the message and format them as a context block. */
async function recallKnowledge(
  kb: KnowledgeBase,
  query: string,
  k: number
): Promise<string | null> {
  let hits;
  try {
    hits = await kb.search(query, k);
  } catch {
    return null;
  }
  if (!hits.length) return null;
  const blocks = hits.map(
    (h) => `### ${h.meta.title} [[${h.meta.slug}]]\n${h.snippet}`
  );
  return (
    "RELEVANT KNOWLEDGE recalled from your long-term memory (use it; read full notes " +
    "with knowledge_read; update them with knowledge_save if you learn more):\n\n" +
    blocks.join("\n\n")
  );
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
  toolSpecs: ToolSpec[],
  history: Message[],
  meter: TokenMeter,
  ask: () => Promise<string>
): Promise<void> {
  let nudged = false;
  const reasoning = isReasoningModel(s.provider.model);

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    // Live status: elapsed time + the session's cumulative input tokens so far
    // (real usage; starts at 0 and climbs as the conversation grows).
    const spinner = new Spinner(thinkingWord(), meter.sessionIn);
    spinner.begin();
    let res: GenerateResult;
    try {
      res = await generateWithFallback(s, history, {
        temperature: reasoning ? REASONING_TEMP : TOOL_TEMP,
        tools: toolSpecs,
      });
    } finally {
      spinner.stop();
    }
    meter.record(res); // fold this request's exact usage into the session totals
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

    // Separate any <think> reasoning from the final answer. Fence detection runs
    // on the answer only, so commands the model merely pondered aren't auto-run.
    const { thinking, answer } = splitThinking(res.text);
    const fencedCmds = extractShellCommands(answer);

    if (fencedCmds.length === 0) {
      // Genuine final answer.
      if (thinking) {
        console.log(chalk.magenta("qwen ⟂ thinking"));
        console.log(chalk.gray(indent(thinking)) + "\n");
      }
      console.log(chalk.green("qwen › ") + (answer || "(no response)") + "\n");
      // Per-turn usage + the running session totals, all from the model's exact
      // counts. (The spinner shows session input before this turn; this is after.)
      if (meter.sessionIn || meter.sessionOut) {
        console.log(
          chalk.gray(
            `  this turn: ↑ ${formatTokens(meter.lastIn)} ↓ ${formatTokens(meter.lastOut)}  ·  ` +
              `session: ↑ ${formatTokens(meter.sessionIn)} ↓ ${formatTokens(meter.sessionOut)} tokens\n`
          )
        );
      }
      // Don't feed the verbose <think> back into context (saves tokens, and
      // reasoning models are trained to see only prior answers).
      history.push({ role: "assistant", content: answer || res.text });
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

/** Configured fallback chain, trimmed and de-duped against the active model. */
function fallbackChain(s: Session): string[] {
  const seen = new Set<string>();
  return (s.config.model.fallback_models ?? [])
    .map((m) => m.trim())
    .filter((m) => m && m.toLowerCase() !== s.provider.model.toLowerCase() && !seen.has(m) && seen.add(m));
}

/**
 * At launch, make sure the configured model is actually installed. If it isn't,
 * switch to the first installed model in the fallback chain so the session still
 * works (e.g. primary still downloading). Best-effort: stays on the configured
 * model if we can't list models, and warns if nothing in the chain is installed.
 */
async function resolveStartupModel(s: Session): Promise<void> {
  const chain = fallbackChain(s);
  if (!chain.length || !s.provider.listModels || !s.provider.setModel) return;

  let installed: ModelInfo[];
  try {
    installed = await s.provider.listModels();
  } catch {
    return; // can't tell — leave the configured model in place
  }
  // Ollama may normalize namespaced/cased tags, so match case-insensitively.
  const has = (name: string) => {
    const n = name.toLowerCase();
    return installed.some((m) => m.name.toLowerCase() === n || m.name.toLowerCase().startsWith(n));
  };
  if (has(s.provider.model)) return; // primary is available, nothing to do

  const pick = chain.find(has);
  if (pick) {
    s.provider.setModel(pick);
    console.log(
      chalk.yellow(`⚠ model "${s.config.model.model}" not installed — using fallback "${pick}".`)
    );
  } else {
    console.log(
      chalk.yellow(
        `⚠ "${s.config.model.model}" and all fallbacks (${chain.join(", ")}) are uninstalled. ` +
          `Pull one with \`ollama pull <name>\` or pick one with /models.`
      )
    );
  }
}

/** Heuristic: does this provider error mean the requested model is unavailable? */
function looksUnavailable(err: Error): boolean {
  return /not found|no such model|unknown model|failed to load|404|model .* does not exist|try pulling/i.test(
    err.message
  );
}

/**
 * Generate, walking the fallback chain if the request fails because the active
 * model is unavailable. Each switch is sticky for the rest of the session (so we
 * don't keep retrying a model that's missing).
 */
async function generateWithFallback(
  s: Session,
  history: Message[],
  options: ModelOptions
): Promise<GenerateResult> {
  try {
    return await s.provider.generate(history, options);
  } catch (err) {
    if (!s.provider.setModel || !looksUnavailable(err as Error)) throw err;
    for (const fb of fallbackChain(s)) {
      console.log(chalk.yellow(`\n⚠ "${s.provider.model}" unavailable — falling back to "${fb}".`));
      s.provider.setModel(fb);
      try {
        return await s.provider.generate(history, options);
      } catch (e2) {
        if (!looksUnavailable(e2 as Error)) throw e2; // a real error, not just a missing model
      }
    }
    throw err; // nothing in the chain worked
  }
}

/**
 * Running tally of the tokens actually consumed this session, accumulated from
 * the EXACT `usage` the model reports after each response (Ollama returns real
 * prompt/completion counts). Starts at 0 and only grows — the spinner shows the
 * cumulative input total, so you watch the session's real cost climb rather
 * than a per-request estimate. Output is tracked too for the per-turn summary.
 */
class TokenMeter {
  sessionIn = 0; // Σ prompt tokens across all requests this session
  sessionOut = 0; // Σ completion tokens
  lastIn = 0; // this turn's prompt tokens
  lastOut = 0; // this turn's completion tokens

  /** Add a completed response's exact usage to the running totals. */
  record(res: GenerateResult): void {
    this.lastIn = res.promptTokens ?? 0;
    this.lastOut = res.completionTokens ?? 0;
    this.sessionIn += this.lastIn;
    this.sessionOut += this.lastOut;
  }
}

/**
 * Slash commands — shared by the live `/` palette (prompt.ts) and the static
 * /help menu. Each entry's name/aliases drive the palette's letter filtering.
 */
const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", aliases: ["/commands", "/?"], desc: "Show this list of commands" },
  { name: "/settings", aliases: ["/config"], desc: "Show the current model & runtime settings" },
  { name: "/models", desc: "List installed models (sizes shown, current marked ●)" },
  { name: "/model", args: "<name|#>", desc: "Switch the active model for this session" },
  { name: "/memory", aliases: ["/knowledge"], desc: "Show the long-term knowledge vault (notes & path)" },
  { name: "/reset", desc: "Clear the conversation history" },
  { name: "/exit", aliases: ["/quit"], desc: "Quit Qwenodyssey" },
];

const CHAT_TOOLS_LINE =
  "run_shell, read/write_file, grep, git, web_search, web_fetch, knowledge_search/save";

/** Render slash commands as an aligned two-column menu, boxed in rules. */
function renderCommandMenu(): string {
  const invocation = (c: SlashCommand) =>
    [c.name, ...(c.aliases ?? [])].join("  ") + (c.args ? " " + c.args : "");
  const pad = Math.max(...SLASH_COMMANDS.map((c) => invocation(c).length)) + 3;
  const rows = SLASH_COMMANDS.map(
    (c) => "  " + chalk.cyan(invocation(c).padEnd(pad)) + chalk.gray(c.desc)
  );
  return [
    hrule(),
    chalk.bold("  Commands"),
    ...rows,
    "  " + chalk.cyan("@path".padEnd(pad)) + chalk.gray("Inline a file's contents into your message"),
    "",
    chalk.gray("  Tip: type ") + chalk.cyan("/") + chalk.gray(" to filter commands as you type."),
    chalk.gray("  The model can also call tools on its own: ") + chalk.dim(CHAT_TOOLS_LINE),
    hrule() + "\n",
  ].join("\n");
}

/** Render the current model + runtime settings as an aligned table. */
function renderSettings(s: Session, kb: KnowledgeBase, memoryEnabled: boolean): string {
  const m = s.config.model;
  const reasoning = isReasoningModel(s.provider.model);
  const embed =
    kb.embeddingsActive() === true
      ? `semantic (${s.config.knowledge.embed_model})`
      : kb.embeddingsActive() === false
      ? "keyword (embed model not pulled)"
      : `semantic if available (${s.config.knowledge.embed_model})`;
  const fbList = (m.fallback_models ?? []).map((x) => x.trim()).filter(Boolean);
  const fbDisplay = fbList.length
    ? fbList
        .map((f) => (f.toLowerCase() === s.provider.model.toLowerCase() ? `${f} (active)` : f))
        .join(" → ")
    : "—";
  const rows: [string, string][] = [
    ["model", `${s.provider.model}  (${s.provider.name} @ ${m.base_url})`],
    ["fallback chain", fbDisplay],
    ["thinking", reasoning ? "deep · native reasoning model" : "step-by-step scaffold"],
    ["temperature", `${reasoning ? REASONING_TEMP : TOOL_TEMP} active · ${m.temperature} base`],
    ["max output tokens", String(m.max_tokens)],
    ["context budget", String(m.context_tokens)],
    ["gpu", gpuPolicy(s)],
    ["agent mode", s.mode],
    ["shell tools", s.config.tools.allow_shell ? "enabled" : "disabled"],
    ["confirm destructive", s.config.tools.confirm_destructive ? "on (asks before risky cmds)" : "off"],
    ["internet", s.config.web.enabled ? `enabled (${s.config.web.provider})` : "disabled"],
    ["long-term memory", memoryEnabled ? `on · ${kb.list().length} notes` : "disabled"],
    ["memory retrieval", memoryEnabled ? embed : "—"],
    ["vault", memoryEnabled ? kb.dir : "—"],
    ["project dir", s.cwd],
  ];
  const pad = Math.max(...rows.map(([k]) => k.length)) + 2;
  const lines = rows.map(([k, v]) => "  " + chalk.gray(k.padEnd(pad)) + v);
  return [
    hrule(),
    chalk.bold("  Settings"),
    ...lines,
    "",
    chalk.gray("  Change with /model, or edit ") + chalk.dim(".qwenodyssey/config.toml") +
      chalk.gray(" (qwenodyssey config set …)"),
    hrule() + "\n",
  ].join("\n");
}

/** Human-readable summary of the GPU offload policy (Ollama num_gpu). */
function gpuPolicy(s: Session): string {
  if (s.provider.name !== "ollama") return "managed by " + s.provider.name;
  const n = s.config.model.gpu_layers;
  const lv = s.config.model.low_vram ? " · low-vram" : "";
  if (n < 0) return "auto · max layers on GPU, overflow → CPU/RAM" + lv;
  if (n === 0) return "CPU only" + lv;
  return `${n} layers forced on GPU` + lv;
}

/** Render the knowledge vault contents and status. */
function renderMemory(kb: KnowledgeBase, s: Session, memoryEnabled: boolean): string {
  if (!memoryEnabled) {
    return hrule() + "\n  " + chalk.gray("Long-term memory is disabled (knowledge.enabled=false).") + "\n" + hrule() + "\n";
  }
  const notes = kb.list();
  const head = [
    hrule(),
    chalk.bold("  Long-term memory"),
    "  " + chalk.gray("vault    ") + kb.dir,
    "  " + chalk.gray("notes    ") + String(notes.length),
    "  " + chalk.gray("retrieval ") +
      (kb.embeddingsActive() === false ? "keyword" : `semantic (${s.config.knowledge.embed_model})`),
    "",
  ];
  const body = notes.length
    ? notes
        .slice(0, 30)
        .map(
          (n) =>
            "  " + chalk.cyan("[[" + n.slug + "]]") + " " + n.title +
            (n.tags.length ? chalk.dim("  #" + n.tags.join(" #")) : "")
        )
    : ["  " + chalk.gray("(empty — the model saves notes as it learns)")];
  return [...head, ...body, hrule() + "\n"].join("\n");
}

/**
 * Split a reply into its chain-of-thought and final answer. Reasoning models
 * (DeepSeek-R1, QwQ) wrap deliberation in <think>…</think>. We surface that
 * dimmed and keep the answer clean. Handles an unterminated <think> (truncated
 * output) by treating the remainder as thinking.
 */
function splitThinking(text: string): { thinking: string; answer: string } {
  const closed = text.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
  if (closed) {
    const thinking = closed[1].trim();
    const answer = text.replace(closed[0], "").trim();
    return { thinking, answer };
  }
  const open = text.match(/<think(?:ing)?>([\s\S]*)$/i);
  if (open) {
    return { thinking: open[1].trim(), answer: "" };
  }
  return { thinking: "", answer: text.trim() };
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
