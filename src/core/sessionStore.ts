/**
 * Persisted chat sessions so a conversation can be resumed later (`--continue`,
 * `--resume`, /resume). Each session is one JSON file under
 * ~/.qwenodyssey/sessions/. We store the message history WITHOUT the system
 * prompt (it's rebuilt fresh on resume so prompt/tool/self-awareness changes take
 * effect), plus lightweight metadata for the picker.
 *
 * Clean-room implementation — inspired by Claude-Code-style session resume, but
 * written from scratch for Qwenodyssey. No third-party source is used.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Message } from "../types";

export interface ChatSessionMeta {
  id: string;
  cwd: string;
  title: string;
  model: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
}

export interface ChatSession extends ChatSessionMeta {
  /** History excluding the leading system message. */
  messages: Message[];
}

export class SessionStore {
  readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir || path.join(os.homedir(), ".qwenodyssey", "sessions");
  }

  ensure(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(id: string): string {
    return path.join(this.dir, id + ".json");
  }

  /** Time-sortable id like 20260608-143501-a1b2. */
  newId(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
  }

  save(session: ChatSession): void {
    try {
      this.ensure();
      fs.writeFileSync(this.file(session.id), JSON.stringify(session), "utf-8");
    } catch {
      /* best effort — never crash chat over a failed save */
    }
  }

  load(id: string): ChatSession | null {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), "utf-8")) as ChatSession;
    } catch {
      return null;
    }
  }

  /** All sessions (metadata only), newest first. */
  list(): ChatSessionMeta[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8")) as ChatSession;
          const { messages, ...meta } = s;
          return meta as ChatSessionMeta;
        } catch {
          return null;
        }
      })
      .filter((m): m is ChatSessionMeta => !!m && !!m.id)
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }

  /** Most recent session started in this directory (for --continue). */
  latestForCwd(cwd: string): ChatSessionMeta | null {
    const norm = path.resolve(cwd).toLowerCase();
    return this.list().find((m) => path.resolve(m.cwd || "").toLowerCase() === norm) || null;
  }
}

/** A short, human-readable title from the first real user message. */
export function deriveTitle(messages: Message[]): string {
  const u = messages.find((m) => m.role === "user");
  if (!u) return "(empty session)";
  let t = (u.content || "").replace(/\s+/g, " ").trim();
  // Strip a recalled-knowledge prefix ("…———…") if present so the title is the question.
  const sep = t.lastIndexOf("———");
  if (sep >= 0) t = t.slice(sep + 3).trim();
  return t.slice(0, 70) || "(session)";
}
