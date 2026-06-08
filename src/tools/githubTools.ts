/**
 * GitHub tools: full read/write access to the user's GitHub account via the REST
 * API. The auth token is resolved automatically so the agent inherits the user's
 * GitHub login with zero config:
 *
 *   1. explicit config token  (github.token)
 *   2. an environment variable (github.token_env, default GITHUB_TOKEN then GH_TOKEN)
 *   3. the GitHub CLI's own token via `gh auth token` (already logged in on this box)
 *
 * With these the model can browse/read repos & files, create repos, upload/commit
 * files, open PRs, and review PRs (diff + submit reviews) — i.e. read, write and
 * review code on the user's account.
 */
import execa from "execa";
import type { Tool } from "../types";

export interface GithubConfig {
  /** Personal access token. Leave blank to fall back to env / gh CLI. */
  token: string;
  /** Env var to read the token from when `token` is blank. */
  tokenEnv: string;
  /** Default owner for owner/repo args (blank = the authenticated user). */
  defaultOwner: string;
  /** REST API base (override for GitHub Enterprise). */
  apiBase: string;
}

const UA = "qwenodyssey-github-tool";

/** Memoised token so we don't shell out to `gh` on every call. */
let cachedToken: string | null = null;

async function resolveToken(cfg: GithubConfig): Promise<string> {
  if (cfg.token) return cfg.token;
  const envName = cfg.tokenEnv || "GITHUB_TOKEN";
  const fromEnv = process.env[envName] || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  if (cachedToken) return cachedToken;
  // Fall back to the GitHub CLI's stored login.
  try {
    const { stdout } = await execa("gh", ["auth", "token"]);
    const tok = stdout.trim();
    if (tok) {
      cachedToken = tok;
      return tok;
    }
  } catch {
    /* gh not installed / not logged in */
  }
  throw new Error(
    "No GitHub token. Set github.token in config, export " +
      (cfg.tokenEnv || "GITHUB_TOKEN") +
      ", or run `gh auth login`."
  );
}

interface GhResponse {
  ok: boolean;
  status: number;
  json: any;
  text: string;
}

async function api(
  cfg: GithubConfig,
  method: string,
  path: string,
  body?: unknown,
  accept = "application/vnd.github+json"
): Promise<GhResponse> {
  const token = await resolveToken(cfg);
  const base = (cfg.apiBase || "https://api.github.com").replace(/\/+$/, "");
  const url = /^https?:\/\//i.test(path) ? path : base + path;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON (e.g. a raw diff) — leave json null */
  }
  return { ok: res.ok, status: res.status, json, text };
}

function fail(label: string, r: GhResponse): { ok: false; output: string } {
  const msg = r.json?.message || r.text || `HTTP ${r.status}`;
  return { ok: false, output: `${label} failed (HTTP ${r.status}): ${msg}` };
}

/** Split an "owner/repo" or bare "repo" arg, defaulting owner to the auth'd user. */
async function splitRepo(cfg: GithubConfig, repoArg: string, login: () => Promise<string>) {
  const raw = String(repoArg || "").trim();
  if (raw.includes("/")) {
    const [owner, repo] = raw.split("/");
    return { owner, repo };
  }
  const owner = cfg.defaultOwner || (await login());
  return { owner, repo: raw };
}

export function createGithubTools(cfg: GithubConfig): Tool[] {
  // Cache the authenticated login for owner-defaulting.
  let loginCache: string | null = null;
  const whoamiLogin = async (): Promise<string> => {
    if (loginCache) return loginCache;
    const r = await api(cfg, "GET", "/user");
    if (!r.ok) throw new Error(r.json?.message || `HTTP ${r.status}`);
    loginCache = r.json.login;
    return loginCache!;
  };

  const githubWhoami: Tool = {
    name: "github_whoami",
    description:
      "Verify the GitHub login the agent is acting as and show its scopes. Call this first if " +
      "you're unsure whether GitHub access is configured.",
    mutating: false,
    async run(_args, ctx) {
      const r = await api(cfg, "GET", "/user");
      if (!r.ok) return fail("github_whoami", r);
      loginCache = r.json.login;
      ctx.log({ tool: "github_whoami", login: r.json.login });
      return {
        ok: true,
        output: `Authenticated as ${r.json.login} (${r.json.name || "no name"}) — ${r.json.public_repos} public repos.`,
        data: r.json,
      };
    },
  };

  const githubListRepos: Tool = {
    name: "github_list_repos",
    description:
      "List repositories on the authenticated GitHub account (most recently pushed first). " +
      "Use to discover what repos exist before reading or writing.",
    mutating: false,
    async run(args, ctx) {
      const per = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
      const r = await api(
        cfg,
        "GET",
        `/user/repos?per_page=${per}&sort=pushed&affiliation=owner,collaborator,organization_member`
      );
      if (!r.ok) return fail("github_list_repos", r);
      const lines = (r.json as any[]).map(
        (x) => `${x.full_name}${x.private ? " (private)" : ""} — ${x.description || "no description"}`
      );
      ctx.log({ tool: "github_list_repos", count: lines.length });
      return { ok: true, output: lines.join("\n") || "(no repositories)", data: r.json };
    },
  };

  const githubGetFile: Tool = {
    name: "github_get_file",
    description:
      "Read a file (or list a directory) from a GitHub repo. Returns decoded file contents so you " +
      "can review code that isn't checked out locally.",
    mutating: false,
    async run(args, ctx) {
      const { owner, repo } = await splitRepo(cfg, args.repo, whoamiLogin);
      const path = String(args.path || "").replace(/^\/+/, "");
      const ref = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : "";
      const r = await api(cfg, "GET", `/repos/${owner}/${repo}/contents/${path}${ref}`);
      if (!r.ok) return fail("github_get_file", r);
      ctx.log({ tool: "github_get_file", repo: `${owner}/${repo}`, path });
      if (Array.isArray(r.json)) {
        const listing = r.json.map((e: any) => `${e.type === "dir" ? "📁" : "  "} ${e.path}`).join("\n");
        return { ok: true, output: `Directory ${path || "/"}:\n${listing}`, data: r.json };
      }
      const content =
        r.json.encoding === "base64"
          ? Buffer.from(r.json.content, "base64").toString("utf-8")
          : r.json.content || "";
      return {
        ok: true,
        output: `${owner}/${repo}/${r.json.path} (sha ${r.json.sha.slice(0, 7)}):\n\n${content}`,
        data: { sha: r.json.sha, content, path: r.json.path },
      };
    },
  };

  const githubPutFile: Tool = {
    name: "github_put_file",
    description:
      "Create or update (upload/commit) a file in a GitHub repo on a branch. Writes code directly to " +
      "GitHub — fetches the existing file's sha automatically when updating. Use to push new or changed files.",
    mutating: true,
    async run(args, ctx) {
      const { owner, repo } = await splitRepo(cfg, args.repo, whoamiLogin);
      const path = String(args.path || "").replace(/^\/+/, "");
      const message = String(args.message || `Update ${path}`);
      const branch = args.branch ? String(args.branch) : undefined;
      if (!path || args.content == null) return { ok: false, output: "github_put_file needs `path` and `content`." };

      // Look up the existing sha (required by the API to update; absent = create).
      let sha: string | undefined;
      const refQ = branch ? `?ref=${encodeURIComponent(branch)}` : "";
      const existing = await api(cfg, "GET", `/repos/${owner}/${repo}/contents/${path}${refQ}`);
      if (existing.ok && !Array.isArray(existing.json)) sha = existing.json.sha;

      const r = await api(cfg, "PUT", `/repos/${owner}/${repo}/contents/${path}`, {
        message,
        content: Buffer.from(String(args.content), "utf-8").toString("base64"),
        ...(sha ? { sha } : {}),
        ...(branch ? { branch } : {}),
      });
      if (!r.ok) return fail("github_put_file", r);
      ctx.log({ tool: "github_put_file", repo: `${owner}/${repo}`, path, updated: !!sha });
      return {
        ok: true,
        output: `${sha ? "Updated" : "Created"} ${owner}/${repo}/${path} → commit ${r.json.commit?.sha?.slice(0, 7)}`,
        data: r.json,
      };
    },
  };

  const githubCreateRepo: Tool = {
    name: "github_create_repo",
    description:
      "Create a new repository on the authenticated account. Optionally auto-initialise it with a README " +
      "so you can immediately commit files to it.",
    mutating: true,
    async run(args, ctx) {
      const name = String(args.name || "").trim();
      if (!name) return { ok: false, output: "github_create_repo needs a `name`." };
      const r = await api(cfg, "POST", "/user/repos", {
        name,
        description: args.description ? String(args.description) : undefined,
        private: args.private !== false, // default private for safety
        auto_init: args.auto_init !== false, // default true so it's immediately writable
      });
      if (!r.ok) return fail("github_create_repo", r);
      ctx.log({ tool: "github_create_repo", repo: r.json.full_name });
      return { ok: true, output: `Created ${r.json.full_name} → ${r.json.html_url}`, data: r.json };
    },
  };

  const githubListPrs: Tool = {
    name: "github_list_prs",
    description: "List pull requests in a repo (open by default). Use before reviewing.",
    mutating: false,
    async run(args, ctx) {
      const { owner, repo } = await splitRepo(cfg, args.repo, whoamiLogin);
      const state = ["open", "closed", "all"].includes(String(args.state)) ? String(args.state) : "open";
      const r = await api(cfg, "GET", `/repos/${owner}/${repo}/pulls?state=${state}&per_page=30`);
      if (!r.ok) return fail("github_list_prs", r);
      const lines = (r.json as any[]).map(
        (p) => `#${p.number} [${p.state}] ${p.title} — ${p.user.login} (${p.head.ref} → ${p.base.ref})`
      );
      ctx.log({ tool: "github_list_prs", repo: `${owner}/${repo}`, count: lines.length });
      return { ok: true, output: lines.join("\n") || "(no pull requests)", data: r.json };
    },
  };

  const githubGetPr: Tool = {
    name: "github_get_pr",
    description:
      "Fetch a pull request's details AND its full diff so you can review the code. Returns title, " +
      "description, changed-file stats and the unified diff.",
    mutating: false,
    async run(args, ctx) {
      const { owner, repo } = await splitRepo(cfg, args.repo, whoamiLogin);
      const num = Number(args.number);
      if (!num) return { ok: false, output: "github_get_pr needs a PR `number`." };
      const meta = await api(cfg, "GET", `/repos/${owner}/${repo}/pulls/${num}`);
      if (!meta.ok) return fail("github_get_pr", meta);
      const diff = await api(
        cfg,
        "GET",
        `/repos/${owner}/${repo}/pulls/${num}`,
        undefined,
        "application/vnd.github.v3.diff"
      );
      ctx.log({ tool: "github_get_pr", repo: `${owner}/${repo}`, number: num });
      const p = meta.json;
      const header =
        `#${p.number} ${p.title} — ${p.user.login} (${p.head.ref} → ${p.base.ref})\n` +
        `state: ${p.state}  +${p.additions} -${p.deletions} across ${p.changed_files} files\n\n` +
        `${p.body || "(no description)"}\n\n--- DIFF ---\n`;
      return { ok: true, output: header + (diff.ok ? diff.text : "(diff unavailable)"), data: p };
    },
  };

  const githubCreatePr: Tool = {
    name: "github_create_pr",
    description: "Open a pull request from a head branch into a base branch.",
    mutating: true,
    async run(args, ctx) {
      const { owner, repo } = await splitRepo(cfg, args.repo, whoamiLogin);
      const r = await api(cfg, "POST", `/repos/${owner}/${repo}/pulls`, {
        title: String(args.title || ""),
        head: String(args.head || ""),
        base: String(args.base || "main"),
        body: args.body ? String(args.body) : undefined,
        draft: args.draft === true,
      });
      if (!r.ok) return fail("github_create_pr", r);
      ctx.log({ tool: "github_create_pr", repo: `${owner}/${repo}`, number: r.json.number });
      return { ok: true, output: `Opened PR #${r.json.number} → ${r.json.html_url}`, data: r.json };
    },
  };

  const githubReviewPr: Tool = {
    name: "github_review_pr",
    description:
      "Submit a review on a pull request after reading it with github_get_pr. Choose an event: " +
      "APPROVE, REQUEST_CHANGES, or COMMENT, with a body explaining the review.",
    mutating: true,
    async run(args, ctx) {
      const { owner, repo } = await splitRepo(cfg, args.repo, whoamiLogin);
      const num = Number(args.number);
      const event = String(args.event || "COMMENT").toUpperCase();
      if (!num) return { ok: false, output: "github_review_pr needs a PR `number`." };
      if (!["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(event))
        return { ok: false, output: "event must be APPROVE, REQUEST_CHANGES, or COMMENT." };
      const r = await api(cfg, "POST", `/repos/${owner}/${repo}/pulls/${num}/reviews`, {
        body: String(args.body || ""),
        event,
      });
      if (!r.ok) return fail("github_review_pr", r);
      ctx.log({ tool: "github_review_pr", repo: `${owner}/${repo}`, number: num, event });
      return { ok: true, output: `Submitted ${event} review on PR #${num}.`, data: r.json };
    },
  };

  const githubCreateIssue: Tool = {
    name: "github_create_issue",
    description: "Open an issue in a repo (e.g. to file a bug or track work found while reviewing).",
    mutating: true,
    async run(args, ctx) {
      const { owner, repo } = await splitRepo(cfg, args.repo, whoamiLogin);
      const r = await api(cfg, "POST", `/repos/${owner}/${repo}/issues`, {
        title: String(args.title || ""),
        body: args.body ? String(args.body) : undefined,
        labels: Array.isArray(args.labels) ? args.labels : undefined,
      });
      if (!r.ok) return fail("github_create_issue", r);
      ctx.log({ tool: "github_create_issue", repo: `${owner}/${repo}`, number: r.json.number });
      return { ok: true, output: `Opened issue #${r.json.number} → ${r.json.html_url}`, data: r.json };
    },
  };

  return [
    githubWhoami,
    githubListRepos,
    githubGetFile,
    githubPutFile,
    githubCreateRepo,
    githubListPrs,
    githubGetPr,
    githubCreatePr,
    githubReviewPr,
    githubCreateIssue,
  ];
}
