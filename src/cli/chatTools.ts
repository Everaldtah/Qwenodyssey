/**
 * JSON-schema tool specs advertised to the model during chat, plus a small
 * runner that maps a model tool-call onto the project's ToolRegistry.
 */
import type { ToolSpec } from "../types";

const str = (description: string) => ({ type: "string", description });

/**
 * The subset of registry tools we expose in interactive chat. Names MUST match
 * the registry tool names so calls dispatch directly.
 */
export const CHAT_TOOL_SPECS: ToolSpec[] = [
  {
    name: "run_shell",
    description:
      "Execute a shell command in the project directory and return its combined stdout/stderr. " +
      "Use this for any real action: checking the OS, network/wifi status, running tests, git, " +
      "listing processes, installing packages, etc. On Windows the shell is PowerShell/cmd.",
    parameters: {
      type: "object",
      properties: { command: str("The exact command line to run.") },
      required: ["command"],
    },
  },
  {
    name: "shell_help",
    description:
      "Look up the EXACT verified Windows PowerShell command for a task BEFORE running it when " +
      "you're unsure (login/event logs, processes, services, network, users, disk, files, hardware, " +
      "performance, firewall, scheduled tasks, installed software). Returns ready-to-run commands; " +
      "then call run_shell with one. Saves you from guessing cmdlet names/flags.",
    parameters: {
      type: "object",
      properties: { query: str('Task or topic, e.g. "login logs last week", "top memory processes", "wifi".') },
    },
  },
  {
    name: "read_file",
    description:
      "Read a file's contents. The path may be relative to the project dir OR an absolute path " +
      'like "C:\\Projects\\Overstory\\README.md".',
    parameters: {
      type: "object",
      properties: { path: str("File path — relative to the project, or absolute.") },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content.",
    parameters: {
      type: "object",
      properties: {
        path: str("Path to the file, relative to the project root."),
        content: str("Full new contents of the file."),
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description:
      "List files under a directory (recursively) matching an optional glob. Use `path` to target " +
      "a specific directory, including an absolute one outside the project.",
    parameters: {
      type: "object",
      properties: {
        path: str('Directory to list — relative or absolute (e.g. "C:\\Projects\\Overstory"). Optional; defaults to the project dir.'),
        pattern: str('Glob like "src/**/*.ts". Optional.'),
      },
    },
  },
  {
    name: "tree",
    description:
      "Show a compact, depth-limited directory tree. Use `path` to point at any directory — " +
      'including an absolute path the user names, e.g. "C:\\Projects\\Overstory".',
    parameters: {
      type: "object",
      properties: {
        path: str('Directory to show — relative or absolute. Optional; defaults to the project dir.'),
        depth: { type: "integer", description: "Max depth (default 2)." },
      },
    },
  },
  {
    name: "grep",
    description: "Search file contents for a regex pattern. Use `path` to search a specific (or absolute) directory.",
    parameters: {
      type: "object",
      properties: {
        pattern: str("Regular expression to search for."),
        path: str("Directory to search — relative or absolute. Optional; defaults to the project dir."),
        glob: str('Optional glob to limit files, e.g. "**/*.ts".'),
      },
      required: ["pattern"],
    },
  },
  {
    name: "git_status",
    description: "Show the git working-tree status.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "git_diff",
    description: "Show the current git diff, optionally for one path.",
    parameters: {
      type: "object",
      properties: { path: str("Optional path to scope the diff.") },
    },
  },
];

/** Internet tools — included when web.enabled. */
export const WEB_TOOL_SPECS: ToolSpec[] = [
  {
    name: "web_search",
    description:
      "Search the internet for information you don't already know or that may be current " +
      "(library docs, APIs, error messages, recent facts). Returns titles, URLs and snippets.",
    parameters: {
      type: "object",
      properties: { query: str("What to search for.") },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a URL and return its readable text (HTML stripped). Use to read a search result or a known docs page.",
    parameters: {
      type: "object",
      properties: { url: str("The http(s) URL to fetch.") },
      required: ["url"],
    },
  },
];

/** Long-term memory tools — included when knowledge.enabled. */
export const KNOWLEDGE_TOOL_SPECS: ToolSpec[] = [
  {
    name: "knowledge_search",
    description:
      "Search your long-term memory for what you've already learned. Check here BEFORE the web.",
    parameters: {
      type: "object",
      properties: { query: str("Topic, concept, codebase, or API to recall.") },
      required: ["query"],
    },
  },
  {
    name: "knowledge_read",
    description: "Read a full note from memory by its slug.",
    parameters: {
      type: "object",
      properties: { slug: str("The note slug, e.g. from knowledge_search results.") },
      required: ["slug"],
    },
  },
  {
    name: "knowledge_save",
    description:
      "Save or update a note in long-term memory so you remember it permanently. Use whenever " +
      "you learn something durable (how code works, an API, a fix, a looked-up fact). Reusing a " +
      "title updates that note. Cite source URLs when available.",
    parameters: {
      type: "object",
      properties: {
        title: str("Short, specific note title (also the update key)."),
        content: str("Distilled, durable knowledge in markdown. Use [[wikilinks]] to relate notes."),
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
        sources: { type: "array", items: { type: "string" }, description: "Optional source URLs." },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "knowledge_list",
    description: "List the titles of everything in your knowledge vault.",
    parameters: { type: "object", properties: {} },
  },
];

export const CHAT_TOOL_NAMES = new Set(CHAT_TOOL_SPECS.map((t) => t.name));
