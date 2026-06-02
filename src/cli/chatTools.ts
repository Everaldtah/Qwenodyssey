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
    name: "read_file",
    description: "Read a file's contents (relative to the project directory).",
    parameters: {
      type: "object",
      properties: { path: str("Path to the file, relative to the project root.") },
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
    description: "List files matching an optional glob pattern (default: everything).",
    parameters: {
      type: "object",
      properties: { pattern: str('Glob like "src/**/*.ts". Optional.') },
    },
  },
  {
    name: "tree",
    description: "Show a compact, depth-limited directory tree.",
    parameters: {
      type: "object",
      properties: { depth: { type: "integer", description: "Max depth (default 2)." } },
    },
  },
  {
    name: "grep",
    description: "Search file contents for a regex pattern across the project.",
    parameters: {
      type: "object",
      properties: {
        pattern: str("Regular expression to search for."),
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

export const CHAT_TOOL_NAMES = new Set(CHAT_TOOL_SPECS.map((t) => t.name));
