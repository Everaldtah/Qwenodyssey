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
  {
    name: "update_plan",
    description:
      "Lay out and track a step-by-step plan for a MULTI-STEP task. Call it once at the start to " +
      "list the steps, then again to update statuses as you progress. Always pass the FULL plan " +
      "(the list is replaced each time). Keeps you on track over long tool chains.",
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "array",
          description: "The full ordered list of steps.",
          items: {
            type: "object",
            properties: {
              step: str("Short description of the step."),
              status: { type: "string", enum: ["pending", "in_progress", "done"], description: "Step status." },
            },
            required: ["step", "status"],
          },
        },
      },
      required: ["plan"],
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
    description:
      "Fetch a URL and return its readable text (HTML stripped). Pass `query` to get only the most " +
      "relevant sentences (condensed, token-cheap) instead of the whole page.",
    parameters: {
      type: "object",
      properties: {
        url: str("The http(s) URL to fetch."),
        query: str("Optional: condense the page to sentences relevant to this, to save tokens."),
      },
      required: ["url"],
    },
  },
  {
    name: "web_research",
    description:
      "Answer a question from the LIVE web in one call: searches, reads the top results, and returns a " +
      "compact query-focused digest (key sentences + sources) instead of raw pages. Use for anything " +
      "current/online — today's news, latest releases, prices, recent facts. Summarises large pages " +
      "cheaply so it won't overflow the context.",
    parameters: {
      type: "object",
      properties: {
        query: str("What to research, e.g. \"today's top news headlines\"."),
        pages: { type: "integer", description: "How many top results to read & condense (default 3, max 5)." },
      },
      required: ["query"],
    },
  },
];

/** GitHub tools — included when github.enabled and a login/token is available. */
export const GITHUB_TOOL_SPECS: ToolSpec[] = [
  {
    name: "github_whoami",
    description:
      "Show which GitHub account the agent is acting as (and its scopes). Use to confirm GitHub access.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "github_list_repos",
    description:
      "List repositories on the user's GitHub account (most recently pushed first). Use to discover repos.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", description: "Max repos to list (default 30, max 100)." } },
    },
  },
  {
    name: "github_get_file",
    description:
      "Read a file (or list a directory) from a GitHub repo to review code that isn't checked out locally.",
    parameters: {
      type: "object",
      properties: {
        repo: str('Repo as "owner/name" or just "name" (defaults owner to your account).'),
        path: str("Path within the repo. Empty/'/' lists the root directory."),
        ref: str("Optional branch, tag, or commit SHA."),
      },
      required: ["repo", "path"],
    },
  },
  {
    name: "github_put_file",
    description:
      "Create or update (upload/commit) a file in a GitHub repo. Writes code straight to GitHub; the " +
      "existing file's sha is fetched automatically when updating.",
    parameters: {
      type: "object",
      properties: {
        repo: str('Repo as "owner/name" or just "name".'),
        path: str("Path within the repo to write."),
        content: str("Full new file contents (UTF-8)."),
        message: str("Commit message."),
        branch: str("Optional branch to commit to (default the repo's default branch)."),
      },
      required: ["repo", "path", "content"],
    },
  },
  {
    name: "github_create_repo",
    description: "Create a new repository on the user's account (private + auto-initialised by default).",
    parameters: {
      type: "object",
      properties: {
        name: str("Repository name."),
        description: str("Optional description."),
        private: { type: "boolean", description: "Private repo (default true)." },
        auto_init: { type: "boolean", description: "Initialise with a README so it's immediately writable (default true)." },
      },
      required: ["name"],
    },
  },
  {
    name: "github_list_prs",
    description: "List pull requests in a repo (open by default).",
    parameters: {
      type: "object",
      properties: {
        repo: str('Repo as "owner/name" or just "name".'),
        state: { type: "string", enum: ["open", "closed", "all"], description: "Default 'open'." },
      },
      required: ["repo"],
    },
  },
  {
    name: "github_get_pr",
    description:
      "Fetch a pull request's details AND full unified diff so you can review the code change.",
    parameters: {
      type: "object",
      properties: {
        repo: str('Repo as "owner/name" or just "name".'),
        number: { type: "integer", description: "PR number." },
      },
      required: ["repo", "number"],
    },
  },
  {
    name: "github_create_pr",
    description: "Open a pull request from a head branch into a base branch.",
    parameters: {
      type: "object",
      properties: {
        repo: str('Repo as "owner/name" or just "name".'),
        title: str("PR title."),
        head: str("Head branch (the branch with your changes)."),
        base: str("Base branch to merge into (default 'main')."),
        body: str("Optional PR description."),
        draft: { type: "boolean", description: "Open as a draft (default false)." },
      },
      required: ["repo", "title", "head"],
    },
  },
  {
    name: "github_review_pr",
    description:
      "Submit a review on a PR after reading it with github_get_pr. Pick an event and explain it.",
    parameters: {
      type: "object",
      properties: {
        repo: str('Repo as "owner/name" or just "name".'),
        number: { type: "integer", description: "PR number." },
        event: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"], description: "Review verdict." },
        body: str("Review comment / summary."),
      },
      required: ["repo", "number", "event", "body"],
    },
  },
  {
    name: "github_create_issue",
    description: "Open an issue in a repo (e.g. file a bug found while reviewing).",
    parameters: {
      type: "object",
      properties: {
        repo: str('Repo as "owner/name" or just "name".'),
        title: str("Issue title."),
        body: str("Optional issue body."),
        labels: { type: "array", items: { type: "string" }, description: "Optional labels." },
      },
      required: ["repo", "title"],
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
  {
    name: "record_lesson",
    description:
      "Record a durable LESSON learned from a mistake or a user correction so you don't repeat it. " +
      "Lessons are auto-recalled in future turns. Use after a tool/command failed and you found the " +
      "right approach, or when the user corrects you.",
    parameters: {
      type: "object",
      properties: {
        lesson: str("The reusable rule/takeaway, 1-2 sentences (name the correct tool/command/approach)."),
        title: str("Optional short title."),
      },
      required: ["lesson"],
    },
  },
];

/** Agent-swarm tool — included when ≥2 frontier workers (cloud keys) are available. */
export const SWARM_TOOL_SPECS: ToolSpec[] = [
  {
    name: "agent_swarm",
    description:
      "Spin up a SWARM of frontier models that run IN PARALLEL — each worker is a different cloud " +
      "model on its own API key, all executing at the same time. Use for genuinely COMPLEX tasks: " +
      "hard reasoning/design/debugging where multiple strong perspectives help (mode 'ensemble'), or " +
      "a big job that splits into independent parts you can parallelize (mode 'divide'). For simple " +
      "questions answer directly instead. Returns each worker's answer plus a single synthesized result.",
    parameters: {
      type: "object",
      properties: {
        task: str("The overall task/question for the swarm (always required, even in divide mode — it frames the subtasks)."),
        mode: {
          type: "string",
          enum: ["ensemble", "divide"],
          description:
            "'ensemble' (default): every model answers the SAME task, then their answers are merged into the best one. " +
            "'divide': shard `subtasks` across the models, one per worker, all at once.",
        },
        subtasks: {
          type: "array",
          items: { type: "string" },
          description: "Independent subtasks to parallelize (required for mode 'divide').",
        },
        synthesize: {
          type: "boolean",
          description: "Merge the workers' outputs into one final answer (default true).",
        },
      },
      required: ["task"],
    },
  },
];

export const CHAT_TOOL_NAMES = new Set(CHAT_TOOL_SPECS.map((t) => t.name));
