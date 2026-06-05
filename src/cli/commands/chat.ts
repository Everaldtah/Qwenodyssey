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
import { createPrompt, selectFromList, SlashCommand, SelectItem } from "../prompt";
import { createProvider, createLmStudioProvider } from "../../providers";
import { KnowledgeBase } from "../../core/knowledge";
import { EvolutionEngine, TurnSignals } from "../../core/evolution";
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

This machine runs Windows and run_shell executes through WINDOWS POWERSHELL (5.1) — NOT
cmd.exe. So use real PowerShell cmdlets: Get-Process, Get-Service, Get-WinEvent,
Get-NetIPConfiguration, Get-CimInstance, Get-ChildItem, Select-String, etc. (cmd-only
syntax like 'dir /b' or the old 'eventquery' will fail.)

SHELL ENCYCLOPEDIA: when you're not 100% sure of the exact command for a system task —
login/event logs, processes, services, network/wifi, users, disk, files, hardware,
performance, firewall, scheduled tasks, installed software — call shell_help {query:"…"}
FIRST to get the verified command, then run it with run_shell. Don't guess cmdlet names or
flags and retry blindly. If a command needs Administrator rights (e.g. the Security event
log) and fails with access denied, say so and give the user the command to run elevated.

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
You have REAL-TIME INTERNET ACCESS (web_research, web_search, web_fetch) and LONG-TERM
MEMORY (a personal knowledge vault).

NEVER tell the user you "don't have internet access", "can't browse", or that your
knowledge has a cutoff — you CAN fetch live data. For ANY question about current, recent,
live, or time-sensitive information — today's news, latest releases, prices, weather,
sports scores, "what happened", who/what is X now — you MUST call web_research FIRST and
answer from the results. Do not answer such questions from memory and do not just hand the
user URLs to check themselves.

- web_research {query} — best default: one call searches + reads the top pages + returns a
  compact, condensed digest. Use it for news/current-info and to summarise large online
  content cheaply (it condenses pages in-code, so it barely uses any tokens).
- web_search {query} — just the result list (titles/links/snippets).
- web_fetch {url, query} — read one page; pass query to get only the relevant, condensed part.

Knowledge workflow: check knowledge_search first for things you've already learned (also
auto-recalled below when relevant); research the web when memory lacks it; then DISTILL and
knowledge_save durable facts (reuse a title to update a note; cite source URLs). Build deep,
durable understanding so future sessions start smarter, and prefer saved knowledge over guessing.`;

/**
 * Tells the model the concrete truth about itself: where its persistent memory
 * lives, that its own source code is on disk and editable, and that it learns
 * from mistakes. Paths are real so it can answer "do you remember / where?"
 * truthfully and actually modify itself.
 */
function selfAwareness(
  s: Session,
  kb: KnowledgeBase,
  memoryEnabled: boolean,
  evolutionOn: boolean
): string {
  const lines = [
    `SELF-AWARENESS — you are "Qwenodyssey", a local AI coding agent running on the user's PC. ` +
      `You have persistent memory AND your own source code on this machine, and you can change both. ` +
      `Never claim you "have no memory", "don't store anything", or "can't modify yourself" — you can.`,
  ];
  if (memoryEnabled) {
    lines.push(
      `• MEMORY (persists across sessions): your knowledge vault is markdown files at "${kb.dir}". ` +
        `You DO store information on disk. Save with knowledge_save, recall with knowledge_search / ` +
        `knowledge_list / knowledge_read. If asked whether you remember something or where it's kept, ` +
        `answer truthfully and give this path.`
    );
  }
  lines.push(
    `• SOURCE CODE (you can modify yourself): your program lives at "${s.selfRoot}". Read it with ` +
      `tree/read_file/grep and improve it with write_file (absolute paths under that root are allowed). ` +
      `After editing your source, rebuild with run_shell: \`npm --prefix "${s.selfRoot}" run build\` ` +
      `(and \`npm --prefix "${s.selfRoot}" test\`); changes take effect next launch. Edit yourself ` +
      `carefully, keep changes small, and explain what you changed.`
  );
  if (evolutionOn) {
    lines.push(
      `• EVOLUTION (learn from mistakes): when a tool/command fails or you get something wrong, after ` +
        `resolving it call record_lesson with the durable takeaway so you don't repeat it. Your past ` +
        `lessons are recalled to you automatically — apply them. You also reflect automatically after ` +
        `rough turns. Over time these lessons make you smarter.`
    );
  }
  return lines.join("\n");
}

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

  // Long-term knowledge vault (RAG memory). Created on first use.
  const kb = new KnowledgeBase(s.config.knowledge.path, {
    baseUrl: s.config.model.base_url,
    embedModel: s.config.knowledge.embed_model,
  });
  const memoryEnabled = s.config.knowledge.enabled;
  if (memoryEnabled) kb.ensure();

  // Self-improvement: reflect on failed turns and bank lessons in the vault.
  const evolution =
    memoryEnabled && s.config.evolution.enabled
      ? new EvolutionEngine(kb, (m, o) => s.provider.generate(m, o), {
          enabled: true,
          reflectOnFailure: s.config.evolution.reflect_on_failure,
        })
      : null;

  // Base system prompt now; the PROJECT summary is appended once the repo scan
  // finishes in the background (so a slow scan doesn't delay the prompt).
  let sys = loadPrompt("system") + "\n" + TOOL_SYSTEM + "\n" + DEEP_THINK;
  if (memoryEnabled || s.config.web.enabled) sys += "\n" + MEMORY_SYSTEM;
  sys += "\n" + selfAwareness(s, kb, memoryEnabled, !!evolution);
  const history: Message[] = [{ role: "system", content: sys }];

  // Heavy startup work runs in the BACKGROUND so the banner/prompt appear
  // instantly; we await it (usually already finished) before the first turn.
  const ready = (async () => {
    const jobs: Promise<unknown>[] = [];
    if (s.config.lmstudio.enabled && s.lms.installed()) {
      jobs.push(
        (async () => {
          try {
            if (s.config.lmstudio.start_server) {
              await s.lms.ensureServer(lmsPort(s.config.lmstudio.base_url), "0.0.0.0", s.config.lmstudio.base_url);
            }
            s.lmsModelKeys = (await s.lms.list()).map((m) => m.key);
          } catch {
            /* LM Studio optional */
          }
        })()
      );
    }
    jobs.push(
      scanRepo(s.cwd)
        .then((repo) => {
          const summary = summarizeRepo(repo);
          if (summary.trim()) history[0].content += "\n\nPROJECT:\n" + summary;
        })
        .catch(() => {})
    );
    await Promise.all(jobs);
    await resolveStartupModel(s); // may switch model; needs the LM Studio list first
  })();

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
    selfRoot: s.selfRoot,
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
    if (line === "/lessons" || line === "/evolution") {
      console.log(renderLessons(evolution));
      continue;
    }
    if (line === "/model" || line === "/models" || line.startsWith("/model ") || line.startsWith("/models ")) {
      lastModels = await handleModels(s, line, lastModels);
      continue;
    }

    // Make sure background startup (project scan, model resolution, LM Studio)
    // has finished before the first real turn. Instant once it's done.
    await ready;

    let userContent = expandFileRefs(line, s.cwd);

    // Auto-recall: prepend relevant long-term-memory notes to the USER message
    // (not as a separate system message — multiple system messages break some
    // model prompt templates, e.g. LM Studio's qwen3.5: "No user query found").
    if (memoryEnabled && s.config.knowledge.auto_recall) {
      const recalled = await recallKnowledge(kb, line, s.config.knowledge.recall_k);
      if (recalled) userContent = `${recalled}\n\n———\n\n${userContent}`;
    }

    history.push({ role: "user", content: userContent });

    try {
      const signals = await runAssistantTurn(s, chatTools, toolSpecs, history, meter, ask);
      // Evolution: reflect on rough turns and bank a lesson for next time.
      if (evolution) {
        const learned = await evolution.reflect({ ...signals, userMessage: line });
        if (learned) console.log(chalk.magenta(`  ✦ learned a lesson: ${learned}\n`));
      }
    } catch (err) {
      console.log(chalk.red(`\n[error: ${(err as Error).message}]`));
    }
  }
  prompt.close();
  // Exit promptly even if a best-effort background job (LM Studio start / model
  // list) is still pending — there's nothing left to wait for.
  process.exit(0);
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
): Promise<TurnSignals> {
  let nudged = false;
  const reasoning = isReasoningModel(s.provider.model);
  const failures: string[] = [];
  const runCall = async (call: ToolCall): Promise<void> => {
    const r = await executeToolCall(s, tools, call, ask);
    if (!r.ok) {
      const a = JSON.stringify(call.arguments ?? {}).slice(0, 120);
      failures.push(`${call.name} ${a} → ${r.content.slice(0, 200)}`);
    }
    history.push({ role: "tool", tool_call_id: call.id, name: call.name, content: r.content });
  };

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
        think: reasoning,
      });
    } finally {
      spinner.stop();
    }
    meter.record(res); // fold this request's exact usage into the session totals
    const calls = res.toolCalls ?? [];

    // Happy path: the model made real tool calls. Store only the non-reasoning
    // part of the assistant message — leaving a reasoning model's chain-of-thought
    // in history confuses it on later turns.
    if (calls.length > 0) {
      history.push({ role: "assistant", content: splitThinking(res.text).answer || "", tool_calls: calls });
      for (const call of calls) await runCall(call);
      continue;
    }

    // Reasoning: prefer the backend's separate `thinking` field (Ollama), else
    // parse inline <think> tags. Fence detection runs on the answer only, so
    // commands the model merely pondered aren't auto-run.
    const inline = splitThinking(res.text);
    const thinking = (res.thinking?.trim() || inline.thinking).trim();
    const answer = inline.answer;
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
      // Store only the clean answer — NOT res.text (which still holds the raw
      // chain-of-thought). Feeding reasoning back wastes tokens and derails
      // reasoning models on subsequent turns.
      history.push({ role: "assistant", content: answer });
      return { userMessage: "", failures, finalAnswer: answer, stepLimitHit: false };
    }

    if (!nudged) {
      // First regression: correct it without running anything yet.
      nudged = true;
      failures.push("printed a command in a ``` fence instead of calling the run_shell tool");
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
    for (const call of synthetic) await runCall(call);
  }

  console.log(chalk.yellow(`[stopped after ${MAX_TOOL_STEPS} tool steps]`) + "\n");
  history.push({
    role: "assistant",
    content: `Reached the ${MAX_TOOL_STEPS}-step tool limit for this turn.`,
  });
  return { userMessage: "", failures, finalAnswer: "", stepLimitHit: true };
}

/** Port out of an http(s)://host:port base URL (default 1234). */
function lmsPort(baseUrl: string): number {
  const m = baseUrl.match(/:(\d+)/);
  return m ? Number(m[1]) : 1234;
}

/** A fallback/picker entry is "lmstudio:<key>" for LM Studio, else an Ollama tag. */
function parseModelRef(ref: string): { kind: "ollama" | "lmstudio"; model: string } {
  return ref.startsWith("lmstudio:")
    ? { kind: "lmstudio", model: ref.slice("lmstudio:".length) }
    : { kind: "ollama", model: ref };
}

/**
 * Switch the active backend+model. For LM Studio we safe-load the model first
 * (capped context / partial GPU for big ones) so it won't crash the machine,
 * then point the provider at the /v1 server. For Ollama we (re)build the Ollama
 * provider on the target tag.
 */
async function applyModelRef(s: Session, ref: string): Promise<void> {
  const { kind, model } = parseModelRef(ref);
  if (kind === "lmstudio") {
    if (s.config.lmstudio.safe_load) {
      try {
        const m = (await s.lms.list()).find((x) => x.key === model);
        if (m) {
          const r = await s.lms.safeLoad(m, {
            bigParamsB: s.config.lmstudio.big_params_b,
            bigSizeGB: s.config.lmstudio.big_size_gb,
            bigContext: s.config.lmstudio.big_context,
            ttlSeconds: s.config.lmstudio.ttl_seconds,
          });
          if (r.big) console.log(chalk.gray(`  (safe-loaded big model: capped context${m.sizeGB >= 18 ? " + partial GPU" : ""})`));
        }
      } catch {
        /* loading is best-effort; the server may JIT-load on first request */
      }
    }
    s.provider = createLmStudioProvider(s.config, model);
  } else {
    if (s.provider.name !== "ollama") s.provider = createProvider(s.config);
    s.provider.setModel?.(model);
  }
}

/**
 * Ordered fallback chain (refs), de-duped against the active model: the
 * configured Ollama fallbacks plus every installed LM Studio model (tool-capable
 * first) when include_as_fallback is on.
 */
function fallbackChain(s: Session): string[] {
  const seen = new Set<string>();
  const refs = [...(s.config.model.fallback_models ?? []).map((m) => m.trim())];
  if (s.config.lmstudio.enabled && s.config.lmstudio.include_as_fallback) {
    refs.push(...s.lmsModelKeys.map((k) => `lmstudio:${k}`));
  }
  return refs.filter(
    (m) => m && m.toLowerCase() !== s.provider.model.toLowerCase() && !seen.has(m) && seen.add(m)
  );
}

/**
 * At launch, make sure the active model is actually available. If not, switch to
 * the first available model in the fallback chain (Ollama tag installed, or an
 * LM Studio model present). Best-effort.
 */
async function resolveStartupModel(s: Session): Promise<void> {
  const chain = fallbackChain(s);
  if (!chain.length) return;

  let installed: ModelInfo[] = [];
  try {
    if (s.provider.listModels) installed = await s.provider.listModels();
  } catch {
    /* keep going — we can still consider LM Studio fallbacks */
  }
  const ollamaHas = (name: string) => {
    const n = name.toLowerCase();
    return installed.some((m) => m.name.toLowerCase() === n || m.name.toLowerCase().startsWith(n));
  };
  const available = (ref: string) => {
    const { kind, model } = parseModelRef(ref);
    return kind === "lmstudio" ? s.lmsModelKeys.includes(model) : ollamaHas(model);
  };

  if (s.provider.name === "ollama" && ollamaHas(s.provider.model)) return; // primary ok
  if (installed.length === 0 && s.provider.name === "ollama") return; // can't tell

  const pick = chain.find(available);
  if (pick) {
    await applyModelRef(s, pick);
    console.log(chalk.yellow(`⚠ "${s.config.model.model}" not available — using fallback "${pick}".`));
  } else if (installed.length) {
    console.log(
      chalk.yellow(`⚠ "${s.config.model.model}" and all fallbacks are unavailable. Pick one with /model.`)
    );
  }
}

/** Heuristic: does this provider error mean the requested model is unavailable? */
function looksUnavailable(err: Error): boolean {
  return /not found|no such model|unknown model|failed to load|unable to load|cannot load|404|model .* does not exist|try pulling|connection refused|fetch failed|ECONNREFUSED|HTTP 50\d|out of memory|insufficient (memory|vram)|unsupported|no space/i.test(
    err.message
  );
}

/** Embedding models can't chat — keep them out of the model picker/fallbacks. */
function isEmbeddingModel(name: string): boolean {
  return /(^|[-_/])(embed|embedding|bge|gte|e5|nomic-embed)/i.test(name);
}

/**
 * Generate, walking the (provider-aware) fallback chain when a request fails
 * because the active model/backend is unavailable. Switches are sticky.
 */
/** Error means the model can't do tool-calling (so we should retry without tools). */
function noToolSupport(err: Error): boolean {
  return /does not support tools|tools.*not supported|tool (use|calling).*not|unsupported.*tool/i.test(
    err.message
  );
}

/**
 * Generate against the active model, transparently retrying WITHOUT tools if the
 * model rejects tool-calling (e.g. reasoning models like deepseek-r1). The model
 * then simply answers in plain text instead of crashing the turn.
 */
async function tryGenerate(
  s: Session,
  history: Message[],
  options: ModelOptions
): Promise<GenerateResult> {
  try {
    return await s.provider.generate(history, options);
  } catch (err) {
    if (options.tools?.length && noToolSupport(err as Error)) {
      return s.provider.generate(history, { ...options, tools: undefined });
    }
    throw err;
  }
}

async function generateWithFallback(
  s: Session,
  history: Message[],
  options: ModelOptions
): Promise<GenerateResult> {
  try {
    return await tryGenerate(s, history, options);
  } catch (err) {
    if (!looksUnavailable(err as Error)) throw err;
    for (const fb of fallbackChain(s)) {
      console.log(chalk.yellow(`\n⚠ "${s.provider.model}" unavailable — falling back to "${fb}".`));
      await applyModelRef(s, fb);
      try {
        return await tryGenerate(s, history, options);
      } catch (e2) {
        if (!looksUnavailable(e2 as Error)) throw e2;
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
  { name: "/models", desc: "Pick a model with ↑/↓ + Enter (or list when piped)" },
  { name: "/model", args: "[name|#]", desc: "Open the model picker, or switch directly to name/number" },
  { name: "/memory", aliases: ["/knowledge"], desc: "Show the long-term knowledge vault (notes & path)" },
  { name: "/lessons", aliases: ["/evolution"], desc: "Show lessons the agent learned from past mistakes" },
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

/** Render the evolution lessons the agent has learned from past mistakes. */
function renderLessons(evolution: EvolutionEngine | null): string {
  if (!evolution) {
    return hrule() + "\n  " + chalk.gray("Evolution is off (needs knowledge + evolution enabled).") + "\n" + hrule() + "\n";
  }
  const lessons = evolution.lessons();
  const head = [hrule(), chalk.bold(`  Lessons learned  (${lessons.length})`), ""];
  const body = lessons.length
    ? lessons.slice(0, 40).map((n) => "  " + chalk.magenta("✦ ") + n.title.replace(/^Lesson:\s*/i, "") + "\n    " + chalk.gray(n.body.replace(/\s+/g, " ").slice(0, 160)))
    : ["  " + chalk.gray("(none yet — the agent banks a lesson when a turn goes wrong)")];
  return [...head, ...body, "", chalk.gray("  These are auto-recalled in future turns so mistakes aren't repeated."), hrule() + "\n"].join("\n");
}

/**
 * Split a reply into its chain-of-thought and final answer. Reasoning models
 * (DeepSeek-R1, QwQ, qwen3.5) wrap deliberation in <think>…</think>. We surface
 * that dimmed and keep the answer clean. Handles three shapes:
 *  - paired   <think>…</think> answer
 *  - close-only …reasoning…</think> answer  (LM Studio templates pre-fill the
 *    opening <think>, so the model only emits the closing tag)
 *  - open-only <think>…  (truncated/streamed — remainder is all reasoning)
 */
function splitThinking(text: string): { thinking: string; answer: string } {
  const closed = text.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
  if (closed) {
    return { thinking: closed[1].trim(), answer: text.replace(closed[0], "").trim() };
  }
  const closeOnly = text.match(/^([\s\S]*?)<\/think(?:ing)?>\s*([\s\S]*)$/i);
  if (closeOnly) {
    return { thinking: closeOnly[1].trim(), answer: closeOnly[2].trim() };
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
): Promise<{ content: string; ok: boolean }> {
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
        return { content: "Declined by user.", ok: false };
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
  return {
    content: out.slice(0, 8000) || (result.ok ? "(ok, no output)" : "(failed, no output)"),
    ok: result.ok,
  };
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => "  │ " + l)
    .join("\n");
}

interface ModelEntry {
  ref: string; // "lmstudio:<key>" or an ollama tag
  label: string; // display name
  hint: string; // size / backend tag
  current: boolean;
}

/** Gather selectable models from both backends (Ollama tags + LM Studio models). */
async function gatherModelEntries(s: Session, cached: ModelInfo[]): Promise<ModelEntry[]> {
  const entries: ModelEntry[] = [];

  // Ollama tags (only when Ollama is the configured backend).
  let ollama: ModelInfo[] = cached;
  if (s.config.model.provider === "ollama") {
    try {
      const op = s.provider.name === "ollama" ? s.provider : createProvider(s.config);
      if (op.listModels) ollama = await op.listModels();
    } catch {
      /* leave cached */
    }
  }
  for (const m of ollama) {
    if (isEmbeddingModel(m.name)) continue; // embeddings aren't chat models
    entries.push({
      ref: m.name,
      label: m.name,
      hint: [m.size, "ollama"].filter(Boolean).join(" · "),
      current: s.provider.name === "ollama" && m.name === s.provider.model,
    });
  }

  // LM Studio models (headless, tokenless list).
  if (s.config.lmstudio.enabled && s.lms.installed()) {
    try {
      const lms = await s.lms.list();
      for (const m of lms) {
        entries.push({
          ref: `lmstudio:${m.key}`,
          label: m.key,
          hint: `${m.sizeGB.toFixed(1)}GB · lms${m.toolUse ? " · tools" : ""}${m.paramsB >= s.config.lmstudio.big_params_b || m.sizeGB >= s.config.lmstudio.big_size_gb ? " · big" : ""}`,
          current: s.provider.name === "lmstudio" && m.key === s.provider.model,
        });
      }
    } catch {
      /* LM Studio optional */
    }
  }
  return entries;
}

/**
 * `/models` opens a picker over BOTH Ollama and LM Studio models; `/model
 * <name|#>` switches directly. Switching to an LM Studio model safe-loads it
 * and points the backend at LM Studio. Returns the Ollama list for index reuse.
 */
async function handleModels(s: Session, line: string, cached: ModelInfo[]): Promise<ModelInfo[]> {
  const arg = line.split(/\s+/).slice(1).join(" ").trim();
  const entries = await gatherModelEntries(s, cached);
  const ollamaList = entries.filter((e) => !e.ref.startsWith("lmstudio:")).map((e) => ({ name: e.ref }));

  if (entries.length === 0) {
    console.log(chalk.gray("(no models found — pull one with `ollama pull <name>` or install via LM Studio)\n"));
    return cached;
  }

  // No argument → interactive picker (TTY) or numbered list (piped).
  if (!arg) {
    if (process.stdin.isTTY) {
      const currentIdx = Math.max(0, entries.findIndex((e) => e.current));
      const items: SelectItem[] = entries.map((e) => ({ label: e.label, hint: e.hint, current: e.current }));
      const picked = await selectFromList(`Select a model  (● = current)`, items, currentIdx);
      if (picked < 0) console.log(chalk.gray("(model unchanged)\n"));
      else if (entries[picked].current) console.log(chalk.gray(`(already on ${entries[picked].label})\n`));
      else {
        await applyModelRef(s, entries[picked].ref);
        console.log(chalk.green(`✓ switched to ${s.provider.model}`) + chalk.gray(` (${s.provider.name})\n`));
      }
      return ollamaList;
    }
    console.log(chalk.bold("Models (Ollama + LM Studio):"));
    entries.forEach((e, i) => {
      const marker = e.current ? chalk.green("●") : chalk.gray("○");
      console.log(`  ${marker} ${chalk.gray(String(i + 1).padStart(2))}  ${e.label}  ${chalk.gray(e.hint)}`);
    });
    console.log(chalk.gray("\nSwitch with /model <name> or /model <number>\n"));
    return ollamaList;
  }

  // Argument → resolve by 1-based index or by name/key and switch.
  const asIndex = Number(arg);
  let target: ModelEntry | undefined;
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= entries.length) {
    target = entries[asIndex - 1];
  } else {
    const a = arg.toLowerCase();
    target =
      entries.find((e) => e.label.toLowerCase() === a || e.ref.toLowerCase() === a) ||
      entries.find((e) => e.label.toLowerCase().includes(a));
  }
  if (!target) {
    console.log(chalk.red(`[no model matches "${arg}"]`) + chalk.gray(" — run /model to see the list.\n"));
    return ollamaList;
  }
  await applyModelRef(s, target.ref);
  console.log(chalk.green(`✓ switched to ${s.provider.model}`) + chalk.gray(` (${s.provider.name})\n`));
  return ollamaList;
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
