/**
 * Tools that let the model use its long-term knowledge vault: search, read,
 * and save/update notes. Backed by KnowledgeBase (RAG retrieval).
 */
import type { Tool } from "../types";
import type { KnowledgeBase } from "../core/knowledge";

export function createKnowledgeTools(kb: KnowledgeBase): Tool[] {
  const knowledgeSearch: Tool = {
    name: "knowledge_search",
    description:
      "Search your long-term memory (the knowledge vault) for what you've already learned " +
      "about a topic, codebase, API, or concept. Check here BEFORE searching the web.",
    mutating: false,
    async run(args, ctx) {
      const query = String(args.query || "").trim();
      if (!query) return { ok: false, output: "No query given" };
      const hits = await kb.search(query, Number(args.k) || 4);
      ctx.log({ tool: "knowledge_search", query, hits: hits.length });
      if (hits.length === 0) return { ok: true, output: `No notes found for "${query}".` };
      const text = hits
        .map(
          (h) =>
            `[[${h.meta.slug}]] ${h.meta.title}` +
            (h.meta.tags.length ? `  (tags: ${h.meta.tags.join(", ")})` : "") +
            `\n   ${h.snippet}`
        )
        .join("\n\n");
      return { ok: true, output: text };
    },
  };

  const knowledgeRead: Tool = {
    name: "knowledge_read",
    description: "Read a full note from your knowledge vault by its slug (e.g. from knowledge_search).",
    mutating: false,
    async run(args, ctx) {
      const slug = String(args.slug || "").trim();
      const note = kb.read(slug);
      ctx.log({ tool: "knowledge_read", slug, found: !!note });
      if (!note) return { ok: false, output: `No note with slug "${slug}".` };
      return {
        ok: true,
        output:
          `# ${note.title}\n` +
          (note.tags.length ? `tags: ${note.tags.join(", ")}\n` : "") +
          (note.sources.length ? `sources: ${note.sources.join(", ")}\n` : "") +
          `\n${note.body}`,
      };
    },
  };

  const knowledgeSave: Tool = {
    name: "knowledge_save",
    description:
      "Save or update a note in your long-term memory so you remember it permanently. Use this " +
      "whenever you learn something worth keeping: how a codebase works, an API's usage, a fix, " +
      "a fact you looked up. Saving with an existing title UPDATES that note (improving knowledge). " +
      "Write durable, distilled knowledge — not chit-chat. Cite sources (URLs) when you have them.",
    mutating: true,
    async run(args, ctx) {
      const title = String(args.title || "").trim();
      const content = String(args.content || "").trim();
      if (!title || !content) return { ok: false, output: "Need both title and content." };
      const tags = toList(args.tags);
      const sources = toList(args.sources);
      const links = toList(args.links);
      const note = await kb.write({ title, content, tags, sources, links });
      ctx.log({ tool: "knowledge_save", slug: note.slug });
      return { ok: true, output: `Saved note [[${note.slug}]] "${note.title}".` };
    },
  };

  const knowledgeList: Tool = {
    name: "knowledge_list",
    description: "List the titles of everything currently in your knowledge vault.",
    mutating: false,
    async run(_args, ctx) {
      const notes = kb.list();
      ctx.log({ tool: "knowledge_list", count: notes.length });
      if (notes.length === 0) return { ok: true, output: "Knowledge vault is empty." };
      return {
        ok: true,
        output: notes.map((n) => `[[${n.slug}]] ${n.title}`).join("\n"),
      };
    },
  };

  return [knowledgeSearch, knowledgeRead, knowledgeSave, knowledgeList];
}

function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}
