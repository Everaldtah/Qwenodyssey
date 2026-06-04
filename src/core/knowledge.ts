/**
 * Obsidian-style long-term knowledge vault with RAG retrieval.
 *
 * Each note is a markdown file with YAML-ish frontmatter (title, tags, sources,
 * timestamps) and an [[wikilink]]-friendly body. Retrieval is semantic when an
 * Ollama embedding model is available (cosine over cached vectors) and falls
 * back to keyword scoring otherwise. This gives the agent a persistent,
 * improvable memory it can search, read, and update across sessions.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface NoteInput {
  title: string;
  content: string;
  tags?: string[];
  sources?: string[];
  links?: string[];
  slug?: string;
}

export interface NoteMeta {
  slug: string;
  title: string;
  tags: string[];
  sources: string[];
  links: string[];
  created: string;
  updated: string;
  file: string;
}

export interface Note extends NoteMeta {
  body: string;
}

export interface NoteHit {
  meta: NoteMeta;
  score: number;
  snippet: string;
}

interface IndexEntry {
  updated: string;
  vector?: number[];
}

const STOPWORDS = new Set(
  "the a an and or of to in is are for on with as at by be this that it from your you its into how what when".split(
    " "
  )
);

export class KnowledgeBase {
  readonly dir: string;
  private indexPath: string;
  private index: Record<string, IndexEntry> = {};
  private embedOk: boolean | null = null;

  constructor(
    configuredPath: string,
    private opts: { baseUrl: string; embedModel: string }
  ) {
    this.dir = configuredPath
      ? path.resolve(configuredPath)
      : path.join(os.homedir(), ".qwenodyssey", "knowledge");
    this.indexPath = path.join(this.dir, ".index.json");
  }

  ensure(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.indexPath)) {
      try {
        this.index = JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
      } catch {
        this.index = {};
      }
    }
  }

  private saveIndex(): void {
    try {
      fs.writeFileSync(this.indexPath, JSON.stringify(this.index), "utf-8");
    } catch {
      /* best effort */
    }
  }

  /** All notes (parsed). */
  list(): Note[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => this.parse(path.join(this.dir, f)))
      .filter((n): n is Note => !!n)
      .sort((a, b) => b.updated.localeCompare(a.updated));
  }

  read(slug: string): Note | null {
    const file = path.join(this.dir, slugify(slug) + ".md");
    return fs.existsSync(file) ? this.parse(file) : null;
  }

  /**
   * Create a new note or update an existing one (same slug). Updating merges
   * tags/sources and replaces the body, bumping `updated`.
   */
  async write(input: NoteInput): Promise<Note> {
    this.ensure();
    const slug = slugify(input.slug || input.title);
    const file = path.join(this.dir, slug + ".md");
    const now = new Date().toISOString();
    const existing = fs.existsSync(file) ? this.parse(file) : null;

    const meta: NoteMeta = {
      slug,
      title: input.title || existing?.title || slug,
      tags: uniq([...(existing?.tags ?? []), ...(input.tags ?? [])]),
      sources: uniq([...(existing?.sources ?? []), ...(input.sources ?? [])]),
      links: uniq([...(existing?.links ?? []), ...(input.links ?? [])]),
      created: existing?.created ?? now,
      updated: now,
      file,
    };

    fs.writeFileSync(file, render(meta, input.content.trim()), "utf-8");

    // Update the retrieval index (embedding is best-effort).
    const vector = await this.embed(meta.title + "\n" + input.content);
    this.index[slug] = { updated: now, ...(vector ? { vector } : {}) };
    this.saveIndex();

    return { ...meta, body: input.content.trim() };
  }

  /** Rank notes against a query. Semantic when embeddings are available. */
  async search(query: string, k = 4): Promise<NoteHit[]> {
    const notes = this.list();
    if (notes.length === 0) return [];

    const qVec = await this.embed(query);
    let scored: { note: Note; score: number }[];

    if (qVec) {
      // Ensure every note has a cached vector, then cosine-rank.
      scored = [];
      for (const note of notes) {
        let entry = this.index[note.slug];
        if (!entry?.vector || entry.updated !== note.updated) {
          const v = await this.embed(note.title + "\n" + note.body);
          entry = { updated: note.updated, ...(v ? { vector: v } : {}) };
          this.index[note.slug] = entry;
        }
        const score = entry.vector ? cosine(qVec, entry.vector) : 0;
        scored.push({ note, score });
      }
      this.saveIndex();
    } else {
      scored = notes.map((note) => ({ note, score: keywordScore(query, note) }));
    }

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ note, score }) => ({ meta: stripBody(note), score, snippet: snippet(note.body) }));
  }

  /** Embed text via Ollama; returns null (and disables) if unavailable. */
  private async embed(text: string): Promise<number[] | null> {
    if (this.embedOk === false) return null;
    try {
      const root = this.opts.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
      const res = await fetch(`${root}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.opts.embedModel, prompt: text.slice(0, 8000) }),
      });
      if (!res.ok) {
        this.embedOk = false;
        return null;
      }
      const json: any = await res.json();
      const vec: number[] | undefined = json?.embedding;
      if (!Array.isArray(vec) || vec.length === 0) {
        this.embedOk = false;
        return null;
      }
      this.embedOk = true;
      return vec;
    } catch {
      this.embedOk = false;
      return null;
    }
  }

  embeddingsActive(): boolean | null {
    return this.embedOk;
  }

  private parse(file: string): Note | null {
    try {
      const raw = fs.readFileSync(file, "utf-8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const slug = path.basename(file, ".md");
      if (!m) {
        return {
          slug,
          title: slug,
          tags: [],
          sources: [],
          links: [],
          created: "",
          updated: "",
          file,
          body: raw.trim(),
        };
      }
      const fm = parseFrontmatter(m[1]);
      return {
        slug,
        title: fm.title || slug,
        tags: fm.tags ?? [],
        sources: fm.sources ?? [],
        links: fm.links ?? [],
        created: fm.created || "",
        updated: fm.updated || "",
        file,
        body: (m[2] || "").trim(),
      };
    } catch {
      return null;
    }
  }
}

/* ── helpers ── */

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "note";
}

function uniq(a: string[]): string[] {
  return [...new Set(a.filter(Boolean))];
}

function stripBody(n: Note): NoteMeta {
  const { body, ...meta } = n;
  return meta;
}

function snippet(body: string, len = 240): string {
  const clean = body.replace(/\s+/g, " ").trim();
  return clean.length > len ? clean.slice(0, len) + "…" : clean;
}

function render(meta: NoteMeta, body: string): string {
  const fm = [
    "---",
    `title: ${meta.title}`,
    `slug: ${meta.slug}`,
    `tags: [${meta.tags.join(", ")}]`,
    `sources: [${meta.sources.join(", ")}]`,
    `links: [${meta.links.map((l) => `[[${slugify(l)}]]`).join(", ")}]`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    "---",
    "",
  ].join("\n");
  return fm + body + "\n";
}

function parseFrontmatter(text: string): {
  title?: string;
  tags?: string[];
  sources?: string[];
  links?: string[];
  created?: string;
  updated?: string;
} {
  const out: any = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (["tags", "sources", "links"].includes(key)) {
      out[key] = val
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim().replace(/^\[\[|\]\]$/g, ""))
        .filter(Boolean);
    } else {
      out[key] = val.trim();
    }
  }
  return out;
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t)
  );
}

/** Lightweight keyword relevance: term overlap with title/tag boosts. */
function keywordScore(query: string, note: Note): number {
  const q = tokenize(query);
  if (q.length === 0) return 0;
  const titleTerms = new Set(tokenize(note.title + " " + note.tags.join(" ")));
  const bodyTerms = tokenize(note.body);
  const bodyFreq = new Map<string, number>();
  for (const t of bodyTerms) bodyFreq.set(t, (bodyFreq.get(t) ?? 0) + 1);

  let score = 0;
  for (const term of q) {
    if (titleTerms.has(term)) score += 3;
    score += Math.min(bodyFreq.get(term) ?? 0, 4);
  }
  return score / q.length;
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
