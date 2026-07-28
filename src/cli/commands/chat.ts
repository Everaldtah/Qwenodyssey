import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { createSession, GlobalOpts } from "../session";
import { loadPrompt } from "../../core/promptLoader";
import { scanRepo, summarizeRepo } from "../../core/repoScanner";
import { prewarmSymbolIndex } from "../../tools/codeTools";
import { resolveInside } from "../../tools/fileTools";
import { classifyCommand } from "../../tools/shellTools";
import { ToolRegistry } from "../../tools/registry";
import { banner, hrule, Spinner, thinkingWord, formatTokens } from "../render";
import { CHAT_TOOL_SPECS, CODE_NAV_TOOL_SPECS, WEB_TOOL_SPECS, KNOWLEDGE_TOOL_SPECS, SWARM_TOOL_SPECS, GITHUB_TOOL_SPECS, compactToolSpecs } from "../chatTools";
import { createSwarmTools } from "../../tools/swarmTools";
import { createGithubTools } from "../../tools/githubTools";
import { frontierWorkers } from "../../core/swarm";
import { createPrompt, selectFromList, captureInterjections, SlashCommand, SelectItem } from "../prompt";
import {
  createProvider,
  createLmStudioProvider,
  createNvidiaProvider,
  createOpenRouterProvider,
  createAnthropicProvider,
  createOllamaProvider,
  resolveNvidiaKey,
  resolveOpenRouterKey,
  anthropicAuthAvailable,
} from "../../providers";
import { KnowledgeBase } from "../../core/knowledge";
import { EvolutionEngine, TurnSignals } from "../../core/evolution";
import { createKnowledgeTools } from "../../tools/knowledgeTools";
import { createWebTools } from "../../tools/webTools";
import { SessionStore, deriveTitle, ChatSessionMeta } from "../../core/sessionStore";
import { compactHistory, historyTokens, shouldCompact } from "../../core/compactor";
import { extractAllJson } from "../../core/parse";
import { createPlanTool, renderPlan, PlanState } from "../../tools/planTool";
import { createThinkTool, THINK_TOOL_SPEC } from "../../tools/thinkTool";
import { prepareToolCall, resolveToolName } from "../../tools/toolCallPrep";
import { ShellSession } from "../../core/shellSession";
import { createShellSessionTools, SHELL_SESSION_TOOL_SPECS } from "../../tools/shellSessionTools";
import { createMcpTools } from "../../tools/mcpTools";
import type { McpServerSpec } from "../../tools/mcpClient";
import { MODEL_DEFAULTS } from "../../core/config";
import { modelProfile, resolveThinking, samplingFor } from "../../core/modelProfile";
import type { ModelProfile } from "../../core/modelProfile";
import type { GenerateResult, Message, ModelInfo, ModelOptions, ToolCall, ToolContext, ToolSpec } from "../../types";
import type { Session } from "../session";

/** Tool turns run deterministically; temp 0 markedly improves tool adherence. */
const TOOL_TEMP = 0;

/** Cloud backends, where a hard 0 temperature risks repetition loops. */
function isCloudProvider(name: string): boolean {
  return name === "nvidia" || name === "openai" || name === "openrouter" || name === "anthropic";
}

/**
 * What the ACTIVE model is and whether it deliberates this turn. The family
 * profile (core/modelProfile) knows which models have a chain-of-thought and
 * which ones can have it switched off; `model.think` is the user's policy over
 * the top of it. Recomputed per turn because the model can change mid-session
 * (fallback chain / model picker).
 */
function turnProfile(s: Session): { profile: ModelProfile; thinking: boolean | undefined } {
  const profile = modelProfile(s.provider.model);
  return { profile, thinking: resolveThinking(profile, s.config.model.think) };
}

/**
 * Effective temperature for a turn. Tool turns want determinism, so we start at
 * TOOL_TEMP=0 and raise it only to the floors that matter:
 *  - the model family's own floor (Qwen3/3.5 and R1/QwQ degenerate into
 *    repetition loops at 0 — thinking mode needs ~0.6, non-thinking ~0.3;
 *    qwen2.5-coder and friends are stable greedy, so their floor is 0);
 *  - a small cloud floor as anti-degeneration insurance, so a hosted model the
 *    profiler doesn't recognize can't silently loop at 0.
 */
function turnTemperature(
  s: Session,
  profile: ModelProfile,
  thinking: boolean | undefined
): number {
  const cloudFloor = isCloudProvider(s.provider.name) ? 0.2 : 0;
  return Math.max(TOOL_TEMP, samplingFor(profile, thinking).minTurnTemp, cloudFloor);
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

/**
 * Placed FIRST in the assembled system prompt (before all the "you MUST call a
 * tool" sections) so it has primacy. Without this, an eager model reads the
 * tool-forcing rules below and fires read_file / web_search / shell on a bare
 * "hi" — exactly the runaway this prevents. Tools are for ACTING on the machine,
 * live data, or the codebase; ordinary conversation gets a plain reply.
 */
const CONVERSATION_GUARD = `
BEFORE ANYTHING ELSE — decide whether the user's message actually requires a tool.
DO NOT call any tool for: greetings and smalltalk ("hi", "hello", "sup", "yo",
"how are you", "thanks", "lol", "ok"), acknowledgements, opinions, or general
questions you can answer from your own knowledge. For these, reply DIRECTLY in one
or two friendly sentences and STOP — no run_shell, no read_file/list_files/tree,
no web_search, no knowledge_search, no plan. A greeting is NOT a task.
ONLY reach for a tool when the message genuinely needs it: acting on THIS machine
(files, shell, git, processes), live/time-sensitive data from the web, or reading
this codebase. The rules that follow describe HOW to use tools once you've decided
a tool is actually needed — they do NOT mean "always use a tool". When in doubt on
a casual message, just talk.`;

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
Example — user: "what's my internet speed now?"  ✓ correct: call shell_help {query:"internet
speed"}, then run_shell with the fast command it returns. ✗ wrong: pasting a download script
as text, OR replying "I don't have shell/network access" (you DO — you have run_shell).

Questions about THIS computer right now — speed, time, IP, uptime, disk space, what's
running — are a command to ACT: call run_shell immediately, never answer from guesswork and
never deny having access.

EFFICIENT, NON-BLOCKING SHELL USE — run_shell blocks until the command finishes or times out
(~4 min default). To avoid stalls:
- Be EFFICIENT. Do the work in ONE command, not a slow loop. To measure/inspect a remote repo,
  clone it ONCE (\`git clone --depth 1\`) or download its tarball ONCE and work locally — never
  loop fetching files one-by-one over HTTP (that is what just timed out). Use the right tool:
  git, a single API call, \`Measure-Object\`, \`Get-ChildItem -Recurse\`.
- For a command you KNOW is slow (clone, npm/pip install, build, big download), pass a larger
  \`timeout_ms\` (up to 600000) on the run_shell call.
- For genuinely long-running or interactive work (a server, a watch, a REPL, a multi-minute
  build), use shell_session — it runs PERSISTENTLY and you poll it with shell_session_read,
  so it never blocks the turn. If run_shell times out, switch to shell_session rather than
  retrying the same blocking command.
- A timeout returns the PARTIAL output plus a hint; read it and adapt — don't treat it as a
  dead end or repeat the identical command.

This machine runs Windows and run_shell executes through WINDOWS POWERSHELL (5.1) — NOT
cmd.exe. So use real PowerShell cmdlets: Get-Process, Get-Service, Get-WinEvent,
Get-NetIPConfiguration, Get-CimInstance, Get-ChildItem, Select-String, etc. (cmd-only
syntax like 'dir /b' or the old 'eventquery' will fail.)

SHELL ENCYCLOPEDIA: when you're not 100% sure of the exact command for a system task —
login/event logs, processes, services, network/wifi, users, disk, files, hardware,
performance, firewall, scheduled tasks, installed software — call shell_help {query:"…"}
FIRST to get the verified command, then run it with run_shell EXACTLY as returned — copy it
verbatim, keep every \`$\` on PowerShell variables, do not rewrite it or convert it to other
syntax (e.g. \`x = 1\` is Python; PowerShell needs \`$x = 1\`). Don't guess cmdlet names or
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

/**
 * Appended ONLY when the persistent shell session is enabled (tools.shell_session),
 * so the model is never told to use a tool it doesn't have. This is the harness's
 * answer to "don't stall on long tasks": a real terminal whose state persists and
 * that you poll instead of blocking.
 */
const SHELL_SESSION_SYSTEM = `
PERSISTENT SHELL — you also have shell_session / shell_session_read / shell_session_reset.
Unlike run_shell (a fresh, blocking shell each call), shell_session keeps ONE shell alive:
cwd, env vars, activated venvs and background processes survive between calls.
- Use it when commands DEPEND on each other: shell_session {command:"cd build"} then
  shell_session {command:"cmake .."} — the directory persists.
- Use it for LONG or interactive work: start it (shell_session {command:"npm run build"}),
  and if it hasn't finished, call shell_session_read to get more output — it never blocks the
  turn waiting, so a multi-minute job won't time the turn out.
- shell_session_reset restarts the shell if it gets stuck.`;

/**
 * Teaches the model to track multi-step work with the update_plan tool. Small
 * models lose the thread over long tool chains; an explicit, updated plan keeps
 * them coherent.
 */
const PLAN_SYSTEM = `
PLANNING — for any task that needs several steps or multiple tool calls, FIRST call the
update_plan tool with the ordered list of steps, then UPDATE it (mark steps in_progress /
done) as you go. This keeps you on track and lets the user see progress. Skip it for
trivial one-step questions.`;

/**
 * Appended ONLY when agent.thinking_mode is on (the `think` tool exists then).
 * Thinking turns are budgeted separately from tool steps in runAssistantTurn,
 * so telling the model to think "generously" is safe.
 */
const THINK_SYSTEM = `
THINKING — when a step is tricky (a surprising tool result, a choice between approaches,
an error you must diagnose), call the think tool with your reasoning BEFORE acting. It
runs nothing and costs you no tool steps — it's a private scratchpad that keeps your next
action deliberate. Don't think about trivial steps, and never end on a thought: after
thinking, make the real tool call or give your final answer.`;

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
 * Teaches the model that it can fan out to a parallel swarm of frontier models.
 * Only appended when ≥2 frontier workers (cloud API keys) are actually available,
 * so the model never offers a capability it can't use. This is what makes the
 * swarm "auto-activate": the model decides to call agent_swarm on complex tasks.
 */
const SWARM_SYSTEM = `
AGENT SWARM — for genuinely COMPLEX or large tasks you can spin up a swarm of frontier
models that run AT THE SAME TIME, each on a different cloud model and its own API key,
via the agent_swarm tool. Use it when extra reasoning power or parallelism clearly helps:
- mode "ensemble" (default): every model answers the SAME task in parallel, then their
  answers are synthesized into one best result. Use for hard reasoning, design, tricky
  debugging, planning, or review where multiple strong perspectives raise quality.
- mode "divide": pass a "subtasks" array; each independent part is handed to a different
  model concurrently. Use to parallelize a big job that splits into separate pieces.
Judgement: DON'T swarm trivial questions, quick lookups, or routine edits — just answer
or use the normal tools. Reach for agent_swarm when the task is hard or naturally parallel.
Call it at most once per turn; you get back every worker's answer plus the merged result.`;

/**
 * Appended only when ≥1 MCP server connected, listing the namespaces that are
 * live so the model knows the external tools are real and how they're named.
 */
function mcpSystem(servers: string[]): string {
  return `
MCP TOOLS — you are connected to external Model Context Protocol server(s): ${servers.join(", ")}.
Their tools appear with names like mcp__<server>__<tool> and behave like your other tools — call
them directly (no narration) when the task matches what that server provides (e.g. a filesystem,
git, database, browser, or SaaS server). Their arguments follow each tool's own JSON schema. Treat
their output as real results from that system. Prefer a purpose-built MCP tool over a generic shell
command when one clearly fits.`;
}

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
  const backendLabel: Record<string, string> = {
    ollama: "a local Ollama model",
    lmstudio: "a local LM Studio model",
    nvidia: "a cloud model via NVIDIA NIM (integrate.api.nvidia.com)",
    openrouter: "a cloud model via OpenRouter (openrouter.ai)",
    anthropic: "Anthropic's Claude API (api.anthropic.com)",
    openai: "an OpenAI-compatible endpoint",
    vllm: "a local vLLM server",
    llamacpp: "a local llama.cpp server",
  };
  const where = backendLabel[s.provider.name] || `the ${s.provider.name} backend`;
  const lines = [
    `SELF-AWARENESS — you are "Qwenodyssey", an AI coding agent running on the user's PC. ` +
      `RIGHT NOW you are powered by the model "${s.provider.model}" served through ${where} ` +
      `(provider id: ${s.provider.name}). That is your real identity — if the user asks what model ` +
      `or agent you are, answer DIRECTLY from this line in plain words and do NOT call any tool ` +
      `(no knowledge_search, no shell) to answer it; do NOT say you are Qwen 2.5 7B unless that is the model id above. ` +
      `The active model and backend are set in the user's config (~/.qwenodyssey/config.toml) and can be ` +
      `changed live with the /model command or "qwenodyssey config set model.*". ` +
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
 * Replace the SELF-AWARENESS block inside the system prompt (history[0]) in
 * place, preserving anything appended after it (the PROJECT summary, a /compact
 * memo). Called whenever the active model changes so the model's stated identity
 * tracks the real provider/model instead of the one the session launched on.
 */
export function replaceSelfAwareness(history: Message[], newText: string): void {
  const sys = history[0];
  if (!sys || sys.role !== "system") return;
  const start = sys.content.indexOf("SELF-AWARENESS");
  if (start === -1) {
    sys.content += "\n" + newText;
    return;
  }
  // The block ends where the next appended section begins (or at end of prompt).
  const after = sys.content.slice(start);
  const ends = ["\n\nPROJECT:", "\n\n[CONVERSATION SO FAR"]
    .map((m) => after.indexOf(m))
    .filter((i) => i !== -1);
  const tail = ends.length ? after.slice(Math.min(...ends)) : "";
  sys.content = sys.content.slice(0, start) + newText + tail;
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

  // Agent swarm: usable only when ≥2 frontier workers (cloud models with keys)
  // exist. Computed up front so the system prompt and tool set agree.
  const swarmWorkers = s.config.swarm.enabled
    ? frontierWorkers(s.config, {
        maxWorkers: s.config.swarm.max_workers,
        includeLocal: s.config.swarm.include_local,
      })
    : [];
  const swarmReady = swarmWorkers.length >= 2;

  // MCP servers (opt-in): connect + discover tools up front so the system prompt
  // and advertised tool set agree. Connecting here (before selfAwareness is added
  // to `sys`) keeps the MCP block ahead of the SELF-AWARENESS section, so a live
  // /model switch (replaceSelfAwareness) never clips it.
  const mcpSpecs: McpServerSpec[] = s.config.mcp.enabled
    ? Object.entries(s.config.mcp.servers)
        .filter(([, def]) => def.enabled && def.command)
        .map(([name, def]) => ({
          name,
          command: def.command,
          args: def.args,
          env: def.env,
          cwd: def.cwd || undefined,
        }))
    : [];
  const mcp = mcpSpecs.length
    ? await createMcpTools(mcpSpecs, {
        initTimeoutMs: s.config.mcp.init_timeout_ms,
        callTimeoutMs: s.config.mcp.call_timeout_ms,
      })
    : null;
  const mcpServers = mcp ? [...new Set(mcp.tools.map((t) => t.name.split("__")[1]))] : [];

  // Base system prompt now; the PROJECT summary is appended once the repo scan
  // finishes in the background (so a slow scan doesn't delay the prompt).
  let sys = loadPrompt("system") + "\n" + CONVERSATION_GUARD + "\n" + TOOL_SYSTEM + "\n" + DEEP_THINK + "\n" + PLAN_SYSTEM;
  if (s.config.agent.thinking_mode) sys += "\n" + THINK_SYSTEM;
  if (memoryEnabled || s.config.web.enabled) sys += "\n" + MEMORY_SYSTEM;
  if (s.config.tools.shell_session && s.config.tools.allow_shell) sys += "\n" + SHELL_SESSION_SYSTEM;
  if (swarmReady) sys += "\n" + SWARM_SYSTEM;
  if (mcpServers.length) sys += "\n" + mcpSystem(mcpServers);
  sys += "\n" + selfAwareness(s, kb, memoryEnabled, !!evolution);
  const history: Message[] = [{ role: "system", content: sys }];

  // Keep the model's stated identity in sync with the active backend: rebuilt
  // on every model switch / fallback (applyModelRef) so e.g. switching to
  // qwen2.5-coder no longer leaves it claiming to be the cloud primary.
  s.refreshIdentity = () =>
    replaceSelfAwareness(history, selfAwareness(s, kb, memoryEnabled, !!evolution));

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
    // Warm the symbol index so find_symbol / outline_file / read_symbol are
    // instant on first use (small models lean on these heavily for grounding).
    if (s.config.agent.prebuild_symbol_index) {
      jobs.push(prewarmSymbolIndex({
        cwd: s.cwd,
        autoConfirm: true,
        confirmDestructive: false,
        allowShell: s.config.tools.allow_shell,
        sandbox: s.config.tools.sandbox,
        selfRoot: s.selfRoot,
        log: () => {},
      }).catch(() => {}));
    }
    await Promise.all(jobs);
    await resolveStartupModel(s); // may switch model; needs the LM Studio list first
  })();

  console.log(
    banner({
      version: "0.3.0",
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
    allowCommands: s.config.tools.allow_commands,
    denyCommands: s.config.tools.deny_commands,
    shellTimeoutMs: s.config.tools.shell_timeout_ms,
    selfRoot: s.selfRoot,
    log: (entry) => s.logger.event(entry),
  };
  const chatTools = new ToolRegistry(toolCtx);

  // Compose the tool set advertised to the model: shell/file/git always, plus
  // internet and long-term memory when enabled in config.
  const toolSpecs: ToolSpec[] = [...CHAT_TOOL_SPECS, ...CODE_NAV_TOOL_SPECS];
  if (s.config.web.enabled) {
    createWebTools({
      provider: s.config.web.provider,
      apiKey: s.config.web.api_key,
      searxngUrl: s.config.web.searxng_url,
      maxResults: s.config.web.max_results,
      fetchChars: s.config.web.fetch_chars,
      fetchTimeoutMs: s.config.web.fetch_timeout_ms,
    }).forEach((t) => chatTools.register(t));
    toolSpecs.push(...WEB_TOOL_SPECS);
  }
  if (memoryEnabled) {
    createKnowledgeTools(kb).forEach((t) => chatTools.register(t));
    toolSpecs.push(...KNOWLEDGE_TOOL_SPECS);
  }
  if (swarmReady) {
    createSwarmTools(s.config).forEach((t) => chatTools.register(t));
    toolSpecs.push(...SWARM_TOOL_SPECS);
    console.log(
      chalk.gray(
        `  ✦ agent swarm ready — ${swarmWorkers.length} frontier models: ` +
          swarmWorkers.map((w) => w.label).join(", ") + "\n"
      )
    );
  }
  if (s.config.github.enabled) {
    const ghTools = createGithubTools({
      token: s.config.github.token,
      tokenEnv: s.config.github.token_env,
      defaultOwner: s.config.github.default_owner,
      apiBase: s.config.github.api_base,
    });
    ghTools.forEach((t) => chatTools.register(t));
    toolSpecs.push(...GITHUB_TOOL_SPECS);
    // Probe the login so the user sees who the agent acts as (best-effort).
    chatTools.run("github_whoami", {}).then((r) => {
      if (r.ok) console.log(chalk.gray(`  ✦ GitHub ready — ${r.output}\n`));
      else console.log(chalk.gray(`  ✦ GitHub tools loaded (not yet authenticated — run \`gh auth login\`)\n`));
    });
  }

  // MCP: register the tools discovered above and advertise their schemas. The
  // status line reports every server (connected with a tool count, or why it failed).
  if (mcp) {
    mcp.tools.forEach((t) => chatTools.register(t));
    toolSpecs.push(...mcp.specs);
    if (mcp.infos.length) console.log(chalk.gray("  ✦ " + mcp.infos.join("\n  ✦ ") + "\n"));
  }

  // Persistent shell session (opt-in): a real pty whose cwd/env/processes survive
  // across calls, for dependent commands and long-running jobs. Disposed when the
  // chat exits (see the finally below).
  let shellSession: ShellSession | undefined;
  if (s.config.tools.shell_session && s.config.tools.allow_shell) {
    shellSession = new ShellSession(s.cwd);
    createShellSessionTools(shellSession).forEach((t) => chatTools.register(t));
    toolSpecs.push(...SHELL_SESSION_TOOL_SPECS);
    console.log(chalk.gray("  ✦ persistent shell session enabled (shell_session)\n"));
  }

  // In-session plan / TODO tracking (always available) — improves multi-step
  // coherence for small models. The spec is part of CHAT_TOOL_SPECS already.
  const planState: PlanState = { items: [] };
  chatTools.register(createPlanTool(planState));

  // Thinking mode: give the model a `think` scratchpad tool. Think calls spend
  // the separate thinking budget (agent.max_thinking_turns), not tool steps —
  // see runAssistantTurn.
  if (s.config.agent.thinking_mode) {
    chatTools.register(createThinkTool());
    toolSpecs.push(THINK_TOOL_SPEC);
  }

  // Persisted sessions: save after each turn so a conversation can be resumed
  // later with `--continue` / `--resume` / `/resume`.
  const store = new SessionStore();
  let sessionId = store.newId();
  let sessionCreatedAt = new Date().toISOString();
  const persist = (): void => {
    if (history.length <= 1) return; // nothing but the system prompt
    const messages = history.slice(1);
    store.save({
      id: sessionId,
      cwd: s.cwd,
      title: deriveTitle(messages),
      model: s.provider.model,
      provider: s.provider.name,
      createdAt: sessionCreatedAt,
      updatedAt: new Date().toISOString(),
      turns: messages.filter((m) => m.role === "user").length,
      messages,
    });
  };
  // Resume a prior session if requested (replaces history after the system msg).
  const resumed = await resumeSession(store, s, opts, history);
  if (resumed) {
    sessionId = resumed.id;
    sessionCreatedAt = resumed.createdAt;
  }

  // Cached result of the last /models listing, so /model <#> can resolve indexes.
  let lastModels: ModelInfo[] = [];
  // Tracks real token usage and self-calibrates the live "↑ tokens" estimate.
  const meter = new TokenMeter();

  for (;;) {
    let line = (await ask()).trim();
    if (!line) continue;
    // `/btw` is mainly for typing WHILE the model works; at the prompt it's just a
    // normal question, so strip the prefix and fall through to a regular turn.
    if (line === "/btw") {
      console.log(
        chalk.gray("  /btw <question> — ask an aside; also type it while the model is working to queue it\n")
      );
      continue;
    }
    if (/^\/btw\s+/i.test(line)) line = line.replace(/^\/btw\s+/i, "").trim();
    if (line === "/exit" || line === "/quit") break;
    if (line === "/reset") {
      history.length = 1;
      // Strip any compaction memo folded into the system prompt by /compact.
      history[0].content = history[0].content.split("\n\n[CONVERSATION SO FAR")[0];
      sessionId = store.newId();
      sessionCreatedAt = new Date().toISOString();
      planState.items = [];
      console.log(chalk.gray("(history cleared — new session)\n"));
      continue;
    }
    if (line === "/context") {
      console.log(renderContext(s, history));
      continue;
    }
    if (line === "/compact") {
      const r = await compactHistory(history, s.provider, { keepUserTurns: 2 });
      if (r.compacted && r.newMessages) {
        history.splice(0, history.length, ...r.newMessages);
        persist();
        console.log(chalk.gray(`(compacted ${r.removed} earlier messages into a summary)\n`));
      } else {
        console.log(chalk.gray("(not enough history to compact yet)\n"));
      }
      continue;
    }
    if (line === "/plan") {
      console.log(
        hrule() + "\n" + chalk.bold("  Current plan") + "\n" +
          indent(renderPlan(planState.items)) + "\n" + hrule() + "\n"
      );
      continue;
    }
    if (line === "/sessions") {
      console.log(renderSessions(store, sessionId));
      continue;
    }
    if (line === "/resume" || line.startsWith("/resume ")) {
      const arg = line.split(/\s+/).slice(1).join(" ").trim();
      const picked = await chooseSession(store, s.cwd, arg);
      if (picked) {
        const full = store.load(picked.id);
        if (full) {
          history.splice(1, history.length - 1, ...full.messages);
          sessionId = picked.id;
          sessionCreatedAt = picked.createdAt;
          console.log(chalk.green(`✓ resumed ${picked.id}`) + chalk.gray(` — ${full.messages.length} messages · "${picked.title}"\n`));
        }
      } else {
        console.log(chalk.gray("(no matching session)\n"));
      }
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

    // Auto-compact: if the history is near the model's context budget, summarize
    // the oldest turns so we don't overflow (or silently lose the system prompt).
    if (shouldCompact(history, s.provider, { contextTokens: s.config.model.context_tokens, maxTokens: s.config.model.max_tokens })) {
      const r = await compactHistory(history, s.provider, { keepUserTurns: 3 });
      if (r.compacted && r.newMessages) {
        history.splice(0, history.length, ...r.newMessages);
        console.log(chalk.gray(`  ✦ auto-compacted ${r.removed} earlier messages to free up context\n`));
      }
    }

    let userContent = expandFileRefs(line, s.cwd);

    // Trivial greeting/smalltalk → answer directly with NO tools and NO memory
    // cruff. Disabling tools for the turn is a hard backstop so eager models
    // can't fan out read_file/web_search on a bare "hi".
    const smalltalk = isSmalltalk(line);

    // Auto-recall: prepend relevant long-term-memory notes to the USER message
    // (not as a separate system message — multiple system messages break some
    // model prompt templates, e.g. LM Studio's qwen3.5: "No user query found").
    if (memoryEnabled && s.config.knowledge.auto_recall && !smalltalk) {
      const recalled = await recallKnowledge(kb, line, s.config.knowledge.recall_k);
      if (recalled) userContent = `${recalled}\n\n———\n\n${userContent}`;
    }

    history.push({ role: "user", content: userContent });

    try {
      // Small local models get COMPACT tool specs: full frontier-grade
      // descriptions across 35+ tools cost thousands of tokens per request and
      // demonstrably hurt 7B-class tool selection. Names/types/required are
      // preserved, so dispatch (and prepareToolCall hardening) is unaffected.
      const compactSpecs =
        s.config.agent.small_model_mode && !isCloudProvider(s.provider.name)
          ? compactToolSpecs(toolSpecs)
          : toolSpecs;
      const turnSpecs = smalltalk ? [] : compactSpecs;
      const signals = await runAssistantTurn(s, chatTools, turnSpecs, history, meter, ask);
      // Evolution: reflect on rough turns and bank a lesson for next time.
      if (evolution) {
        const learned = await evolution.reflect({ ...signals, userMessage: line });
        if (learned) console.log(chalk.magenta(`  ✦ learned a lesson: ${learned}\n`));
      }
    } catch (err) {
      console.log(chalk.red(`\n[error: ${(err as Error).message}]`));
    }
    persist(); // checkpoint the session after every turn so it can be resumed
  }
  persist();
  prompt.close();
  shellSession?.dispose(); // tear down the persistent pty, if one was started
  mcp?.clients.forEach((c) => c.dispose()); // stop any MCP server processes
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
 * True for trivial conversational messages (greetings, thanks, acks) that need
 * NO tools. These turns run with tools DISABLED so an eager model physically
 * can't fire read_file/web_search/shell on a bare "hi" — a deterministic backstop
 * to the CONVERSATION_GUARD prompt, which some models still ignore. Conservative
 * on purpose: anything with a path, code, URL, "?", or real length is NOT caught,
 * so genuine requests always keep their tools.
 */
const GREET_FIRST = new Set([
  "hi", "hii", "hiya", "hey", "heya", "hello", "helo", "yo", "sup", "wsup",
  "wassup", "howdy", "gm", "gn", "morning", "evening", "greetings", "yt",
]);
function isSmalltalk(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (!t || t.length > 40) return false;
  // A path, file ref, code, URL, or question mark means real work — never skip tools.
  if (/[\\/@`?]|https?:|\.\w{1,4}\b/.test(t)) return false;
  const w = t.replace(/[!.…,~\s]+$/g, "").trim(); // strip trailing punctuation
  const EXACT = new Set([
    "hi", "hii", "hiya", "hey", "heya", "hello", "helo", "hello there", "hi there",
    "hey there", "yo", "sup", "wsup", "wassup", "whats up", "what's up", "howdy",
    "how are you", "how are u", "how r u", "hru", "gm", "good morning",
    "good afternoon", "good evening", "good night", "gn", "thanks", "thank you",
    "thx", "ty", "cheers", "ok", "okay", "k", "kk", "cool", "nice", "great",
    "lol", "lmao", "haha", "hehe", "morning", "evening", "greetings", "test", "ping",
  ]);
  if (EXACT.has(w)) return true;
  // Greeting word + a short address ("sup buddy", "hey man", "yo there friend").
  const words = w.split(/\s+/);
  if (words.length <= 3 && GREET_FIRST.has(words[0])) return true;
  return false;
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
  let emptyNudges = 0;
  let toolAnswerNudges = 0;
  // `thinkOn` = should the model deliberate this turn (undefined = it has no
  // thinking mode). Named apart from the per-step `thinking` TEXT below.
  const { profile, thinking: thinkOn } = turnProfile(s);
  const failures: string[] = [];
  const seenCalls = new Set<string>();

  // ── /btw side-channel ──────────────────────────────────────────────────────
  // Let the user type an aside WHILE the model is working. Each line is queued
  // and injected as a user message at the next step boundary, so the model
  // addresses it without the user waiting for the whole task to finish.
  const pending: string[] = [];
  let currentSpinner: Spinner | undefined;
  let aborter: AbortController | null = null; // set per stream; Esc aborts it
  const interject = captureInterjections({
    label: chalk.yellow("btw › "),
    onStartTyping: () => currentSpinner?.pause(),
    onStopTyping: () => currentSpinner?.resume(),
    onInterrupt: () => aborter?.abort(),
    onSubmit: (text) => {
      const t = text.replace(/^\/btw\b\s*/i, "").trim();
      if (!t) return;
      pending.push(t);
      console.log("\n" + chalk.yellow("  ↩ noted — I'll address that next step: ") + chalk.gray(t) + "\n");
    },
  });
  // A y/N confirm prompt borrows stdin, so release the capture around it.
  const askGuarded = async (): Promise<string> => {
    interject?.suspend();
    try {
      return await ask();
    } finally {
      interject?.resume();
    }
  };
  const drainPending = (): void => {
    while (pending.length) {
      const t = pending.shift()!;
      history.push({
        role: "user",
        content: `[Side question from the user, sent while you were working — address it too, then carry on]: ${t}`,
      });
    }
  };

  // Execute one already-validated call and build its tool-result message.
  const runPrepared = async (call: ToolCall, name: string, args: Record<string, any>): Promise<Message> => {
    const effective: ToolCall = { id: call.id, name, arguments: args };
    const r = await executeToolCall(s, tools, effective, askGuarded);
    if (!r.ok) {
      const a = JSON.stringify(args ?? {}).slice(0, 120);
      failures.push(`${name} ${a} → ${r.content.slice(0, 200)}`);
    }
    return { role: "tool", tool_call_id: call.id, name, content: r.content };
  };

  // Run a batch of tool calls. Each is first hardened (fuzzy name resolution +
  // schema coercion/validation) so a small model's malformed call is corrected
  // or sent back with a targeted error instead of failing cryptically. Read-only
  // (non-mutating) calls that sit consecutively are executed CONCURRENTLY; any
  // mutating call, validation error, or repeated call is handled serially so
  // ordering and the destructive-confirm gate stay intact.
  const runCalls = async (calls: ToolCall[]): Promise<void> => {
    const items = calls.map((call) => {
      const prep = prepareToolCall(call.name, call.arguments, toolSpecs);
      const sig = prep.name + " " + JSON.stringify(prep.arguments ?? {});
      const tool = prep.error ? undefined : tools.get(prep.name);
      const mutating = !tool || tool.mutating;
      return { call, prep, sig, mutating };
    });

    let i = 0;
    while (i < items.length) {
      // Greedily gather a run of parallel-safe reads: validated, non-mutating,
      // and not already executed this turn.
      const batch: typeof items = [];
      while (i < items.length) {
        const it = items[i];
        if (it.prep.error || it.mutating || seenCalls.has(it.sig)) break;
        seenCalls.add(it.sig);
        if (it.prep.note) console.log(chalk.gray(`  (${it.prep.note})`));
        batch.push(it);
        i++;
      }
      if (batch.length > 0) {
        if (batch.length > 1) console.log(chalk.gray(`  ⚡ running ${batch.length} read-only tools in parallel`));
        const msgs = await Promise.all(batch.map((b) => runPrepared(b.call, b.prep.name, b.prep.arguments)));
        msgs.forEach((m) => history.push(m));
        continue;
      }

      // Not parallel-safe — handle exactly one, then re-loop.
      const it = items[i];
      i++;
      const { call, prep, sig } = it;
      if (prep.note) console.log(chalk.gray(`  (${prep.note})`));
      if (prep.error) {
        failures.push(`${call.name} → ${prep.error}`);
        history.push({ role: "tool", tool_call_id: call.id, name: call.name, content: prep.error });
        continue;
      }
      // Loop guard: an identical (resolved) call already ran — don't re-run it.
      if (seenCalls.has(sig)) {
        failures.push(`repeated identical call to ${prep.name} (loop)`);
        history.push({
          role: "tool",
          tool_call_id: call.id,
          name: prep.name,
          content:
            `You ALREADY called ${prep.name} with these arguments and its result is above. ` +
            `Do NOT call it again. Take the NEXT step now: run the actual command with run_shell, ` +
            `or give your final answer.`,
        });
        continue;
      }
      seenCalls.add(sig);
      history.push(await runPrepared(call, prep.name, prep.arguments));
    }
  };

  // Budget only PRODUCTIVE steps (turns that actually ran tools). Corrective
  // nudges (fenced-command warnings, "you reasoned but didn't act", raw-echo
  // reminders) don't burn the budget — they just count against a hard iteration
  // cap so a misbehaving model still can't spin forever.
  const stepBudget = Math.max(1, s.config.agent.max_tool_steps);
  const hardCap = stepBudget * 3;
  let productiveSteps = 0;
  // Thinking mode: `think` calls spend this separate budget instead of tool
  // steps, so deliberation never starves real work. Once exhausted, further
  // think calls DO count as tool steps (and the model is told to act), and the
  // hard iteration cap still bounds everything.
  const knownNames = toolSpecs.map((t) => t.name);
  const thinkingBudget = s.config.agent.thinking_mode ? Math.max(0, s.config.agent.max_thinking_turns) : 0;
  let thinkingTurns = 0;
  let thinkingNudged = false;
  try {
  for (let step = 0; productiveSteps < stepBudget && step < hardCap; step++) {
    // Inject any asides the user typed (/btw) since the last step.
    if (pending.length) drainPending();
    // Live status: elapsed time + the session's cumulative input tokens so far
    // (real usage; starts at 0 and climbs as the conversation grows).
    const spinner = new Spinner(thinkingWord(), meter.sessionIn);
    currentSpinner = spinner;
    spinner.begin();
    let res: GenerateResult;
    // Stream the response so the token meter climbs live (↓ 1, 2, 3 …). We
    // buffer the visible text and print it after the spinner clears, so the
    // animated status line and the answer never fight over the same row. The
    // spinner's ↓ counter is the live feedback during generation.
    aborter = new AbortController();
    try {
      res = await streamWithFallback(s, history, {
        temperature: turnTemperature(s, profile, thinkOn),
        tools: toolSpecs.length ? toolSpecs : undefined,
        think: thinkOn,
        signal: aborter.signal,
      }, spinner);
    } catch (err) {
      // Esc-interrupt: stop this turn cleanly and hand control back to the prompt
      // so the user can redirect — no fallback, no error spew.
      if (isInterrupt(err)) {
        console.log(chalk.yellow("\n  ⏸ interrupted — type your next message.\n"));
        return { userMessage: "", failures, finalAnswer: "", stepLimitHit: false };
      }
      throw err;
    } finally {
      spinner.stop();
      currentSpinner = undefined;
      aborter = null;
    }
    meter.record(res, {
      in: historyTokens(history, s.provider),
      out: s.provider.countTokens(res.text || ""),
    }); // fold this request's exact usage into the session totals (heuristic if omitted)
    let calls = res.toolCalls ?? [];

    // Small models (esp. coder models on Ollama) often emit the tool call as
    // JSON TEXT instead of via the structured tool_calls field. Recover those so
    // they execute instead of being printed as the answer.
    let callsFromText = false;
    if (calls.length === 0) {
      const textCalls = extractTextToolCalls(res.text, toolSpecs, step);
      if (textCalls.length > 0) {
        calls = textCalls;
        callsFromText = true;
      }
    }

    // Happy path: the model made real tool calls. Store only the non-reasoning
    // part of the assistant message — leaving a reasoning model's chain-of-thought
    // in history confuses it on later turns. For text-emitted calls we drop the
    // raw JSON so it isn't fed back as content.
    if (calls.length > 0) {
      history.push({
        role: "assistant",
        content: callsFromText ? "" : splitThinking(res.text).answer || "",
        tool_calls: calls,
      });
      await runCalls(calls);
      // A step that ONLY thought spends a thinking turn, not a tool step
      // (resolve names first so an aliased "reflect"/"thought" call counts too).
      const allThink =
        calls.length > 0 &&
        calls.every((c) => (resolveToolName(c.name, knownNames).name ?? c.name) === "think");
      if (allThink) {
        if (thinkingTurns < thinkingBudget) {
          thinkingTurns++;
          continue;
        }
        if (!thinkingNudged) {
          thinkingNudged = true;
          history.push({
            role: "user",
            content:
              "[system] You've used all your thinking turns. Stop calling `think` — act now: " +
              "make the tool call your plan needs, or give your final answer.",
          });
        }
      }
      productiveSteps++;
      continue;
    }

    // Reasoning: prefer the backend's separate `thinking` field (Ollama), else
    // parse inline <think> tags. Fence detection runs on the answer only, so
    // commands the model merely pondered aren't auto-run.
    const inline = splitThinking(res.text);
    const thinking = (res.thinking?.trim() || inline.thinking).trim();
    // Drop any chat-template tool tags the model leaked into its reply.
    const answer = sanitizeAnswer(inline.answer);
    const fencedCmds = extractShellCommands(answer);

    if (fencedCmds.length === 0) {
      // The model just ran a tool but then either parroted the raw result back
      // (wrapped in <tool_response>, now stripped to empty) or produced no prose.
      // Nudge it once to actually summarize the result in plain words. Bounded.
      const echoed = echoesToolResult(answer, lastToolResult(history));
      if ((!answer.trim() || echoed) && lastToolResult(history) && toolAnswerNudges < 2) {
        toolAnswerNudges++;
        failures.push("returned raw tool output / no prose answer after a tool call");
        history.push({
          role: "user",
          content:
            "[system] Do NOT repeat the tool output or wrap anything in " +
            "<tool_response>/<tool_call> tags. Using the tool result above, answer my " +
            "question directly in one or two plain sentences.",
        });
        continue;
      }

      // Reasoning model planned but produced NO tool call and NO answer (it
      // "thought" about acting then stopped). Nudge it to follow through rather
      // than ending the turn empty. Bounded so it can't loop forever.
      if (!answer.trim() && thinking && emptyNudges < 2) {
        emptyNudges++;
        console.log(chalk.magenta("qwen ⟂ thinking"));
        console.log(chalk.gray(indent(thinking)) + "\n");
        failures.push("reasoned without acting (no tool call or answer)");
        history.push({
          role: "user",
          content:
            "[system] You reasoned but didn't act. Now DO it in this reply: make the actual tool " +
            "call (e.g. shell_help then run_shell), or give your final answer. Don't just describe it.",
        });
        continue;
      }

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
      // A `/btw` aside arrived while finishing? Address it before ending the turn.
      if (pending.length) {
        drainPending();
        continue;
      }
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
    await runCalls(synthetic);
    productiveSteps++;
  }

  console.log(chalk.yellow(`[stopped after ${stepBudget} tool steps]`) + "\n");
  history.push({
    role: "assistant",
    content: `Reached the ${stepBudget}-step tool limit for this turn.`,
  });
  return { userMessage: "", failures, finalAnswer: "", stepLimitHit: true };
  } finally {
    interject?.stop();
  }
}

/** Port out of an http(s)://host:port base URL (default 1234). */
function lmsPort(baseUrl: string): number {
  const m = baseUrl.match(/:(\d+)/);
  return m ? Number(m[1]) : 1234;
}

type ModelKind = "ollama" | "lmstudio" | "nvidia" | "openrouter" | "anthropic";

/**
 * A fallback/picker entry is "lmstudio:<key>" for LM Studio, "nvidia:<model>" for
 * the NVIDIA NIM cloud endpoint, "openrouter:<model>" for OpenRouter,
 * "anthropic:<model>" for the Claude API, else a bare Ollama tag.
 */
function parseModelRef(ref: string): { kind: ModelKind; model: string } {
  if (ref.startsWith("lmstudio:")) return { kind: "lmstudio", model: ref.slice("lmstudio:".length) };
  if (ref.startsWith("nvidia:")) return { kind: "nvidia", model: ref.slice("nvidia:".length) };
  if (ref.startsWith("openrouter:")) return { kind: "openrouter", model: ref.slice("openrouter:".length) };
  if (ref.startsWith("anthropic:")) return { kind: "anthropic", model: ref.slice("anthropic:".length) };
  return { kind: "ollama", model: ref };
}

/** Is an NVIDIA NIM API key available (config or env)? Cloud refs need it. */
function nvidiaKeyPresent(s: Session): boolean {
  return !!resolveNvidiaKey(s.config);
}

/** Is an OpenRouter API key available (config or env)? Cloud refs need it. */
function openRouterKeyPresent(s: Session): boolean {
  return !!resolveOpenRouterKey(s.config);
}

/** Is an Anthropic credential available (OAuth subscription token or API key)? */
function anthropicAuthPresent(s: Session): boolean {
  return anthropicAuthAvailable(s.config);
}

/**
 * Switch the active backend+model. For LM Studio we safe-load the model first
 * (capped context / partial GPU for big ones) so it won't crash the machine,
 * then point the provider at the /v1 server. For Ollama we (re)build the Ollama
 * provider on the target tag.
 */
async function applyModelRef(s: Session, ref: string): Promise<void> {
  const { kind, model } = parseModelRef(ref);
  if (kind === "nvidia") {
    s.provider = createNvidiaProvider(s.config, model);
    s.refreshIdentity?.();
    return;
  }
  if (kind === "openrouter") {
    s.provider = createOpenRouterProvider(s.config, model);
    s.refreshIdentity?.();
    return;
  }
  if (kind === "anthropic") {
    s.provider = createAnthropicProvider(s.config, model);
    s.refreshIdentity?.();
    return;
  }
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
    // Always build a real Ollama provider here: the configured primary provider
    // may be nvidia/openai/etc., so createProvider(s.config) would rebuild the
    // wrong backend. createOllamaProvider targets Ollama regardless.
    if (s.provider.name !== "ollama") s.provider = createOllamaProvider(s.config, model);
    else s.provider.setModel?.(model);
  }
  s.refreshIdentity?.();
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
  const nvidiaOk =
    s.config.nvidia.enabled && s.config.nvidia.include_as_fallback && nvidiaKeyPresent(s);
  const openRouterOk =
    s.config.openrouter.enabled && s.config.openrouter.include_as_fallback && openRouterKeyPresent(s);
  const anthropicOk =
    s.config.anthropic.enabled && s.config.anthropic.include_as_fallback && anthropicAuthPresent(s);
  const activeKind: ModelKind =
    s.provider.name === "nvidia"
      ? "nvidia"
      : s.provider.name === "openrouter"
        ? "openrouter"
        : s.provider.name === "anthropic"
          ? "anthropic"
          : s.provider.name === "lmstudio"
            ? "lmstudio"
            : "ollama";
  return refs.filter((ref) => {
    if (!ref) return false;
    const { kind, model } = parseModelRef(ref);
    if (kind === "nvidia" && !nvidiaOk) return false; // cloud needs a key
    if (kind === "openrouter" && !openRouterOk) return false; // cloud needs a key
    if (kind === "anthropic" && !anthropicOk) return false; // cloud needs auth
    // Drop the currently-active backend+model so we never "fall back" to it.
    if (kind === activeKind && model.toLowerCase() === s.provider.model.toLowerCase()) return false;
    if (seen.has(ref)) return false;
    seen.add(ref);
    return true;
  });
}

/**
 * At launch, make sure the active model is actually available. If not, switch to
 * the first available model in the fallback chain (Ollama tag installed, or an
 * LM Studio model present). Best-effort.
 */
async function resolveStartupModel(s: Session): Promise<void> {
  // NVIDIA cloud primary: usable as long as we have an API key (assume reachable).
  if (s.provider.name === "nvidia") {
    if (nvidiaKeyPresent(s)) return;
    console.log(
      chalk.yellow(
        `⚠ "${s.config.model.model}" needs an NVIDIA API key (set NVIDIA_API_KEY or [nvidia].api_key) — not found. Trying local fallbacks.`
      )
    );
  }

  // OpenRouter cloud primary: usable as long as we have an API key (assume reachable).
  if (s.provider.name === "openrouter") {
    if (openRouterKeyPresent(s)) return;
    console.log(
      chalk.yellow(
        `⚠ "${s.config.model.model}" needs an OpenRouter API key (set OPENROUTER_API_KEY or [openrouter].api_key) — not found. Trying local fallbacks.`
      )
    );
  }

  // Anthropic (Claude) cloud primary: usable as long as we have a credential.
  if (s.provider.name === "anthropic") {
    if (anthropicAuthPresent(s)) return;
    console.log(
      chalk.yellow(
        `⚠ "${s.config.model.model}" needs Anthropic auth — log in with \`ant auth login\` (Claude subscription) or set ANTHROPIC_API_KEY. Trying local fallbacks.`
      )
    );
  }

  const chain = fallbackChain(s);
  if (!chain.length) return;

  // Ollama's installed tags, gathered independently of the active provider so we
  // can judge Ollama fallbacks even when the primary is a cloud/LM Studio backend.
  let ollamaTags: ModelInfo[] = [];
  try {
    const op = s.provider.name === "ollama" ? s.provider : createOllamaProvider(s.config, s.provider.model);
    if (op.listModels) ollamaTags = await op.listModels();
  } catch {
    /* Ollama may be down — we can still consider LM Studio / NVIDIA fallbacks */
  }
  const ollamaHas = (name: string) => {
    const n = name.toLowerCase();
    return ollamaTags.some((m) => m.name.toLowerCase() === n || m.name.toLowerCase().startsWith(n));
  };
  const available = (ref: string) => {
    const { kind, model } = parseModelRef(ref);
    if (kind === "lmstudio") return s.lmsModelKeys.includes(model);
    if (kind === "nvidia") return nvidiaKeyPresent(s);
    if (kind === "openrouter") return openRouterKeyPresent(s);
    if (kind === "anthropic") return anthropicAuthPresent(s);
    return ollamaHas(model);
  };

  if (s.provider.name === "ollama" && ollamaHas(s.provider.model)) return; // primary ok
  if (s.provider.name === "ollama" && ollamaTags.length === 0) return; // Ollama down — can't tell

  const pick = chain.find(available);
  if (pick) {
    await applyModelRef(s, pick);
    console.log(chalk.yellow(`⚠ "${s.config.model.model}" not available — using fallback "${pick}".`));
  } else if (ollamaTags.length || s.provider.name !== "ollama") {
    console.log(
      chalk.yellow(`⚠ "${s.config.model.model}" and all fallbacks are unavailable. Pick one with /model.`)
    );
  }
}

/** Heuristic: does this provider error mean the requested model is unavailable? */
function looksUnavailable(err: Error): boolean {
  return /not found|no such model|unknown model|failed to load|unable to load|cannot load|404|model .* does not exist|try pulling|connection refused|fetch failed|ECONNREFUSED|HTTP 50\d|out of memory|insufficient (memory|vram)|unsupported|no space|401|403|429|unauthorized|forbidden|invalid api key|api key|rate.?limit|quota|timed out|timeout|aborted/i.test(
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
 * Streaming variant: drives the live token ticker (spinner.bumpOut) as output
 * tokens arrive, and updates ↑ once the prompt size is known. Counts output
 * tokens token-by-token via the provider's tokenizer on each delta, so the
 * meter climbs 1, 2, 3 … in real time. Falls back to the blocking path if the
 * provider/model can't stream (and reuses the same unavailable-model fallback
 * chain). The ↑/↓ totals are reconciled to the model's EXACT usage counts when
 * the stream's final usage frame arrives.
 */
/** A user Esc-interrupt surfaces as this sentinel from the provider stream. */
function isInterrupt(err: unknown): boolean {
  return err instanceof Error && err.message === "__interrupted__";
}

async function streamWithFallback(
  s: Session,
  history: Message[],
  options: ModelOptions,
  spinner: Spinner
): Promise<GenerateResult> {
  // Seed ↑ with the measured prompt size so the bar starts truthful, then let
  // the exact prompt_tokens (when returned) reconcile it at the end.
  spinner.setUp(historyTokens(history, s.provider));

  let streamed = "";
  let lastCounted = 0;
  let sinceRecount = 0;
  const onChunk = (delta: string): void => {
    streamed += delta;
    sinceRecount += delta.length;
    // Re-tokenize the accumulated text every ~32 chars (cheap, and the meter
    // only needs to feel live, not be exact mid-stream — the final usage frame
    // reconciles it). This makes ↓ climb smoothly: 1, 2, 3 …
    if (sinceRecount >= 32 || /[\s.,;:})\]]$/.test(delta)) {
      const est = s.provider.countTokens(streamed);
      if (est > lastCounted) {
        spinner.bumpOut(est - lastCounted);
        lastCounted = est;
      }
      sinceRecount = 0;
    }
  };

  const attempt = async (): Promise<GenerateResult> => {
    try {
      const res = await s.provider.stream(history, onChunk, options);
      // Reconcile the live ↓ tick to the exact completion count if we got one.
      if (typeof res.completionTokens === "number") spinner.setOut(res.completionTokens);
      if (typeof res.promptTokens === "number") spinner.setUp(res.promptTokens);
      return res;
    } catch (err) {
      // Model rejects tool-calling mid-stream → retry once without tools.
      if (options.tools?.length && noToolSupport(err as Error)) {
        streamed = "";
        lastCounted = 0;
        sinceRecount = 0;
        return s.provider.stream(history, onChunk, { ...options, tools: undefined });
      }
      throw err;
    }
  };

  try {
    return await attempt();
  } catch (err) {
    if (isInterrupt(err)) throw err; // user interrupt — never fall back or retry
    if (!looksUnavailable(err as Error)) {
      // Streaming genuinely failed for a non-availability reason — fall back to
      // the blocking path so the turn still completes.
      return generateWithFallback(s, history, options);
    }
    for (const fb of fallbackChain(s)) {
      console.log(chalk.yellow(`\n⚠ "${s.provider.model}" unavailable — falling back to "${fb}".`));
      await applyModelRef(s, fb);
      streamed = "";
      lastCounted = 0;
      sinceRecount = 0;
      try {
        return await attempt();
      } catch (e2) {
        if (!looksUnavailable(e2 as Error)) {
          return generateWithFallback(s, history, options);
        }
      }
    }
    throw err;
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

  /**
   * Add a completed response's exact usage to the running totals. If a backend
   * omits usage (some OpenAI-compatible servers don't emit a usage frame), pass
   * `estimate` (heuristic prompt + completion counts) so the meter keeps a
   * truthful-ish tally rather than freezing at zero.
   */
  record(res: GenerateResult, estimate?: { in?: number; out?: number }): void {
    this.lastIn = res.promptTokens ?? estimate?.in ?? 0;
    this.lastOut = res.completionTokens ?? estimate?.out ?? 0;
    this.sessionIn += this.lastIn;
    this.sessionOut += this.lastOut;
  }
}

/** Resolve which saved session to resume from CLI flags (--continue / --resume[=id]). */
async function resumeSession(
  store: SessionStore,
  s: Session,
  opts: GlobalOpts,
  history: Message[]
): Promise<{ id: string; createdAt: string } | null> {
  if (!opts.continue && !opts.resume) return null;
  let meta: ChatSessionMeta | null = null;
  if (typeof opts.resume === "string" && opts.resume) {
    meta = store.list().find((m) => m.id === opts.resume) || null;
    if (!meta) {
      console.log(chalk.red(`No saved session "${opts.resume}".`) + "\n");
      return null;
    }
  } else if (opts.resume === true) {
    meta = await chooseSession(store, s.cwd, "");
  } else if (opts.continue) {
    meta = store.latestForCwd(s.cwd);
    if (!meta) {
      console.log(chalk.gray("(no previous session in this directory — starting fresh)\n"));
      return null;
    }
  }
  if (!meta) return null;
  const full = store.load(meta.id);
  if (!full) return null;
  for (const m of full.messages) history.push(m);
  console.log(
    chalk.green(`✓ resumed session ${meta.id}`) +
      chalk.gray(` — ${full.messages.length} messages · "${meta.title}"\n`)
  );
  return { id: meta.id, createdAt: meta.createdAt };
}

/** Pick a saved session by id (exact/substring) or interactively when no arg. */
async function chooseSession(
  store: SessionStore,
  _cwd: string,
  arg: string
): Promise<ChatSessionMeta | null> {
  const all = store.list();
  if (!all.length) {
    console.log(chalk.gray("(no saved sessions yet)\n"));
    return null;
  }
  if (arg) return all.find((m) => m.id === arg) || all.find((m) => m.id.includes(arg)) || null;
  if (!process.stdin.isTTY) return all[0];
  const items: SelectItem[] = all.slice(0, 30).map((m) => ({
    label: m.title || m.id,
    hint: `${m.turns} turns · ${(m.updatedAt || "").slice(0, 16).replace("T", " ")} · ${path.basename(m.cwd || "")}`,
  }));
  const idx = await selectFromList("Resume which session?", items, 0);
  return idx < 0 ? null : all[idx];
}

/** Render the saved-session list for /sessions. */
function renderSessions(store: SessionStore, currentId: string): string {
  const all = store.list();
  const head = [hrule(), chalk.bold(`  Saved sessions  (${all.length})`), ""];
  const body = all.length
    ? all
        .slice(0, 30)
        .map(
          (m) =>
            "  " + (m.id === currentId ? chalk.green("● ") : chalk.gray("○ ")) +
            chalk.cyan(m.id) + "  " + (m.title || "") +
            chalk.dim(`  · ${m.turns} turns · ${(m.updatedAt || "").slice(0, 16).replace("T", " ")}`)
        )
    : ["  " + chalk.gray("(none yet)")];
  return [
    ...head,
    ...body,
    "",
    chalk.gray("  Resume with ") + chalk.cyan("/resume <id>") + chalk.gray(", or relaunch ") + chalk.cyan("qwenodyssey chat --resume"),
    hrule() + "\n",
  ].join("\n");
}

/** Render a context-usage bar: estimated history tokens vs the model's budget. */
function renderContext(s: Session, history: Message[]): string {
  const used = historyTokens(history, s.provider);
  const budget = s.config.model.context_tokens;
  const pct = Math.min(100, Math.round((used / Math.max(1, budget)) * 100));
  const width = 28;
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const color = pct >= 85 ? chalk.red : pct >= 65 ? chalk.yellow : chalk.green;
  const msgs = history.length - 1;
  return [
    hrule(),
    chalk.bold("  Context usage"),
    "  " + color(bar) + `  ${pct}%`,
    "  " + chalk.gray("estimated ") + `${formatTokens(used)} / ${formatTokens(budget)} tokens` + chalk.gray(`  ·  ${msgs} messages`),
    "  " + chalk.gray("auto-compacts near the limit; force now with ") + chalk.cyan("/compact"),
    hrule() + "\n",
  ].join("\n");
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
  { name: "/context", desc: "Show how much of the context window is used" },
  { name: "/compact", desc: "Summarize older turns now to free up context" },
  { name: "/plan", desc: "Show the agent's current step-by-step plan" },
  { name: "/memory", aliases: ["/knowledge"], desc: "Show the long-term knowledge vault (notes & path)" },
  { name: "/lessons", aliases: ["/evolution"], desc: "Show lessons the agent learned from past mistakes" },
  { name: "/sessions", desc: "List saved chat sessions you can resume" },
  { name: "/resume", args: "[id]", desc: "Resume a saved session (pick from a list, or by id)" },
  { name: "/btw", args: "<question>", desc: "Aside — also type it while the model is working to queue it" },
  { name: "/reset", desc: "Clear history and start a new session" },
  { name: "/exit", aliases: ["/quit"], desc: "Quit Qwenodyssey" },
];

const CHAT_TOOLS_LINE =
  "run_shell, read/write_file, grep, git, web_search, web_fetch, knowledge_search/save, update_plan";

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

/**
 * How one optional sampling knob is actually resolved: an explicit config value,
 * the model profile's recommendation, or off (left to the backend's default).
 */
function samplingKnob(
  configured: number,
  fallbackDefault: number,
  fromProfile: number | undefined,
  autoTune: boolean
): string {
  if (configured !== fallbackDefault) return String(configured);
  if (autoTune && fromProfile) return `${fromProfile} (auto)`;
  return "off";
}

/** Render the current model + runtime settings as an aligned table. */
function renderSettings(s: Session, kb: KnowledgeBase, memoryEnabled: boolean): string {
  const m = s.config.model;
  const { profile, thinking } = turnProfile(s);
  const sampling = samplingFor(profile, thinking);
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
    [
      "model profile",
      m.auto_tune ? `${profile.family} · auto-tuned` : `${profile.family} · auto-tune off`,
    ],
    [
      "thinking",
      !profile.reasoning
        ? "step-by-step scaffold"
        : thinking
        ? `deep · native reasoning (${m.think})`
        : `off for speed · scaffold only (${m.think}${profile.hybridThinking ? ", hybrid" : ""})`,
    ],
    [
      "temperature",
      `${turnTemperature(s, profile, thinking)} active · ${m.temperature} base` +
        (m.auto_tune ? ` · profile ${sampling.temperature}` : ""),
    ],
    [
      "sampling",
      [
        `top_p ${m.auto_tune && m.top_p === MODEL_DEFAULTS.top_p ? sampling.topP : m.top_p}`,
        `top_k ${samplingKnob(m.top_k, MODEL_DEFAULTS.top_k, sampling.topK, m.auto_tune)}`,
        `repeat ${samplingKnob(m.repeat_penalty, MODEL_DEFAULTS.repeat_penalty, sampling.repeatPenalty, m.auto_tune)}`,
        `presence ${samplingKnob(m.presence_penalty, MODEL_DEFAULTS.presence_penalty, sampling.presencePenalty, m.auto_tune)}`,
      ].join(" · "),
    ],
    ["max output tokens", String(m.max_tokens)],
    [
      "context budget",
      String(m.context_tokens) +
        (m.context_tokens < profile.contextSuggestion
          ? chalk.gray(`  (${profile.family} can use ${profile.contextSuggestion})`)
          : ""),
    ],
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

/**
 * Strip chat-template tool-call artifacts a model leaks into its visible answer.
 * Small/coder models (qwen2.5-coder) sometimes parrot the tool result back
 * wrapped in <tool_response>…</tool_response> — or emit <tool_call> / special
 * <|…|> tokens — instead of writing a real reply. None of that is ever a
 * legitimate answer, so we remove the whole blocks; an empty result then routes
 * to the "no real answer" nudge below.
 */
export function sanitizeAnswer(text: string): string {
  return text
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<\/?tool_(?:response|call)\s*>/gi, "")
    .replace(/<\|[^|>]*\|>/g, "")
    .trim();
}

/** The content of the most recent tool result in history, if any. */
function lastToolResult(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "tool") return history[i].content || "";
  }
  return "";
}

/**
 * True when the model's "answer" is really just the tool output handed back
 * (verbatim or nearly so) rather than a synthesized reply. Compared on collapsed
 * whitespace so formatting differences don't hide an echo.
 */
function echoesToolResult(answer: string, toolResult: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const a = norm(answer);
  const t = norm(toolResult);
  if (a.length < 40 || t.length < 40) return false;
  return t.includes(a) || a.includes(t.slice(0, Math.min(t.length, 200)));
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

/**
 * Recover tool calls a small model emitted as TEXT — a JSON object/array with
 * {name, arguments} — instead of via the structured tool_calls field. Coder
 * models on Ollama (e.g. qwen2.5-coder) routinely WRITE the call in a ```json
 * fence rather than using native function-calling, which left the harness
 * printing the raw JSON as the "answer". We map those onto real tool calls,
 * accepting the common shape variants ({tool_call:…}, {function:…}, parameters/
 * args aliases) and only for tools we actually advertised this turn.
 */
function extractTextToolCalls(text: string, toolSpecs: ToolSpec[], step: number): ToolCall[] {
  if (!text) return [];
  const knownNames = toolSpecs.map((t) => t.name);
  const known = new Set(knownNames);
  const calls: ToolCall[] = [];
  const seen = new Set<string>();

  const consider = (raw: any) => {
    if (!raw || typeof raw !== "object") return;
    const o = raw.tool_call ?? raw.function ?? raw.tool ?? raw;
    let name = typeof o?.name === "string" ? o.name : typeof o?.tool_name === "string" ? o.tool_name : undefined;
    if (!name) return;
    if (!known.has(name)) {
      // A text-emitted call with a hallucinated name ("bash", "read", "cat")
      // used to be dropped here — the raw JSON then printed as the "answer".
      // Route it through the same alias/fuzzy resolver dispatched calls get.
      const resolved = resolveToolName(name, knownNames);
      if (!resolved.name) return; // genuinely unknown → leave as prose
      name = resolved.name;
    }
    let args: any = o.arguments ?? o.parameters ?? o.args ?? o.input ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    if (!args || typeof args !== "object") args = {};
    const key = name + JSON.stringify(args);
    if (seen.has(key)) return; // de-dupe a call the model repeated
    seen.add(key);
    calls.push({ id: `text_${step}_${calls.length}`, name, arguments: args });
  };

  for (const value of extractAllJson(text)) {
    if (Array.isArray(value)) value.forEach(consider);
    else consider(value);
  }
  return calls;
}

/**
 * Char budget for ONE tool result fed back into history, scaled to the model's
 * context window (~4 chars/token; tool output may take ~12% of the window per
 * call). The old fixed 8000-char cap flooded a 4–8K-context model in two or
 * three shell calls, evicting the system prompt's tool rules — a major driver
 * of mid-conversation hallucination. Clamped to [2000, 8000].
 */
function toolResultBudget(s: Session): number {
  const ctx = s.config.model.context_tokens || 16384;
  return Math.max(2000, Math.min(8000, Math.floor(ctx * 4 * 0.12)));
}

/**
 * Middle-out truncation: keep the head AND the tail. Tool output carries its
 * verdict at the end (exit status, test summary, the actual error) — tail-only
 * truncation used to cut exactly the part the model needed next.
 */
function truncateMiddle(out: string, budget: number): string {
  if (out.length <= budget) return out;
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  const omitted = out.length - head - tail;
  return out.slice(0, head) + `\n…[${omitted} chars omitted — middle of output]…\n` + out.slice(-tail);
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
  if (call.name === "run_shell" || call.name === "shell_session") {
    const cmd = String(args.command ?? "").trim();
    const tag = call.name === "shell_session" ? "  $⟳ " : "  $ ";
    console.log(chalk.gray(tag) + chalk.cyan(cmd));

    const cls = classifyCommand(cmd, {
      allow: s.config.tools.allow_commands,
      deny: s.config.tools.deny_commands,
    });
    if (cls === "blocked") {
      console.log(chalk.red("  ⛔ refused (hard-blocked / deny-listed)\n"));
      return { content: `Refused: "${cmd}" is hard-blocked or deny-listed and was not run.`, ok: false };
    }
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
  // Feed back head+tail within a context-scaled budget: small models keep the
  // error/exit summary (usually at the END of output) without flooding their
  // context window and evicting the system prompt.
  return {
    content: truncateMiddle(out, toolResultBudget(s)) || (result.ok ? "(ok, no output)" : "(failed, no output)"),
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
  ref: string; // "lmstudio:<key>", "nvidia:<model>", or a bare ollama tag
  label: string; // display name
  hint: string; // size / backend tag
  current: boolean;
}

/** Gather selectable models from both backends (Ollama tags + LM Studio models). */
async function gatherModelEntries(s: Session, cached: ModelInfo[]): Promise<ModelEntry[]> {
  const entries: ModelEntry[] = [];

  // Ollama tags — listed whenever the local Ollama server is reachable, not just
  // when it's the configured primary (mirrors how LM Studio models are always
  // offered). This lets you pick a local model even with a cloud primary.
  let ollama: ModelInfo[] = [];
  try {
    const op = s.provider.name === "ollama" ? s.provider : createOllamaProvider(s.config, s.provider.model);
    if (op.listModels) ollama = await op.listModels();
  } catch {
    /* Ollama not running — skip its entries */
  }
  if (ollama.length === 0) ollama = cached; // fall back to a previously fetched list
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

  // NVIDIA NIM cloud models (the configured primary and any nvidia:* fallbacks),
  // shown only when an API key is available.
  if (s.config.nvidia.enabled && nvidiaKeyPresent(s)) {
    const nvModels = new Set<string>();
    if (s.config.model.provider === "nvidia") nvModels.add(s.config.model.model);
    for (const ref of s.config.model.fallback_models ?? []) {
      const t = ref.trim();
      if (t.startsWith("nvidia:")) nvModels.add(t.slice("nvidia:".length));
    }
    for (const model of nvModels) {
      entries.push({
        ref: `nvidia:${model}`,
        label: model,
        hint: "nvidia · cloud",
        current: s.provider.name === "nvidia" && model === s.provider.model,
      });
    }
  }

  // OpenRouter cloud models (the configured primary and any openrouter:* fallbacks),
  // shown only when an API key is available.
  if (s.config.openrouter.enabled && openRouterKeyPresent(s)) {
    const orModels = new Set<string>();
    if (s.config.model.provider === "openrouter") orModels.add(s.config.model.model);
    for (const ref of s.config.model.fallback_models ?? []) {
      const t = ref.trim();
      if (t.startsWith("openrouter:")) orModels.add(t.slice("openrouter:".length));
    }
    for (const model of orModels) {
      entries.push({
        ref: `openrouter:${model}`,
        label: model,
        hint: "openrouter · cloud",
        current: s.provider.name === "openrouter" && model === s.provider.model,
      });
    }
  }

  // Anthropic (Claude) models — shown whenever a credential is available (an OAuth
  // subscription token from `ant`, or an API key). We seed the current Claude
  // lineup so the user can pick one directly, plus the configured primary and any
  // anthropic:* fallbacks. This is "the place to use Anthropic models".
  if (anthropicAuthAvailable(s.config)) {
    const claudeModels = new Set<string>([
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-opus-4-7",
      "claude-fable-5",
    ]);
    if (s.config.model.provider === "anthropic") claudeModels.add(s.config.model.model);
    for (const ref of s.config.model.fallback_models ?? []) {
      const t = ref.trim();
      if (t.startsWith("anthropic:")) claudeModels.add(t.slice("anthropic:".length));
    }
    for (const model of claudeModels) {
      entries.push({
        ref: `anthropic:${model}`,
        label: model,
        hint: "anthropic · claude",
        current: s.provider.name === "anthropic" && model === s.provider.model,
      });
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
