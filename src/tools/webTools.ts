/**
 * Internet access tools: web_search (find pages) and web_fetch (read a page).
 * Default search provider is keyless DuckDuckGo HTML; Tavily/Brave/SearXNG are
 * supported when an api_key / url is configured.
 */
import type { Tool } from "../types";

export interface WebConfig {
  provider: "duckduckgo" | "tavily" | "brave" | "searxng";
  apiKey: string;
  searxngUrl: string;
  maxResults: number;
  fetchChars: number;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function createWebTools(cfg: WebConfig): Tool[] {
  const webSearch: Tool = {
    name: "web_search",
    description:
      "Search the internet for current information you don't already know (docs, APIs, " +
      "library usage, errors, recent facts). Returns titles, URLs and snippets. Follow up " +
      "with web_fetch to read a promising result in full.",
    mutating: false,
    async run(args, ctx) {
      const query = String(args.query || args.q || "").trim();
      if (!query) return { ok: false, output: "No query given" };
      try {
        const results = await search(query, cfg);
        ctx.log({ tool: "web_search", query, results: results.length });
        if (results.length === 0) return { ok: true, output: `No results for "${query}".` };
        const text = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");
        return { ok: true, output: text };
      } catch (err) {
        return { ok: false, output: `web_search failed: ${(err as Error).message}` };
      }
    },
  };

  const webFetch: Tool = {
    name: "web_fetch",
    description:
      "Fetch a URL and return its readable text (HTML stripped). Pass `query` to get back only " +
      "the most relevant sentences (condensed, token-cheap) instead of the whole page. Use after " +
      "web_search, or directly when you know the URL (e.g. official docs).",
    mutating: false,
    async run(args, ctx) {
      const url = String(args.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, output: "Provide an http(s) URL." };
      const query = String(args.query || "").trim();
      try {
        const text = await fetchReadable(url, cfg);
        const out = query
          ? condense(text, query, cfg.fetchChars)
          : text.slice(0, cfg.fetchChars) + (text.length > cfg.fetchChars ? "\n…(truncated)" : "");
        ctx.log({ tool: "web_fetch", url, bytes: text.length, condensed: !!query });
        return { ok: true, output: `Source: ${url}\n\n${out}` };
      } catch (err) {
        return { ok: false, output: `web_fetch failed: ${(err as Error).message}` };
      }
    },
  };

  // One-shot research: search + read the top pages + condense each to a compact,
  // query-focused digest. This is how the model answers current-info questions
  // (news, latest, prices…) without pulling whole pages into context — the
  // condensing is extractive (done in code), so it costs ZERO model tokens.
  const webResearch: Tool = {
    name: "web_research",
    description:
      "Answer a question from the live web in one call: searches, reads the top results, and returns " +
      "a COMPACT query-focused digest (key sentences + source URLs) rather than raw pages. Use this " +
      "for anything current/online (today's news, latest releases, prices, facts) — it summarises " +
      "large pages cheaply so it won't blow up the context.",
    mutating: false,
    async run(args, ctx) {
      const query = String(args.query || "").trim();
      if (!query) return { ok: false, output: "No query given" };
      const pages = Math.min(Math.max(Number(args.pages) || 3, 1), 5);
      try {
        const results = await search(query, cfg);
        if (results.length === 0) return { ok: true, output: `No web results for "${query}".` };
        const chosen = results.slice(0, pages);
        const budgetPer = Math.max(500, Math.floor(3500 / chosen.length));
        const parts: string[] = [];
        for (const r of chosen) {
          let digest = r.snippet || "";
          try {
            const text = await fetchReadable(r.url, cfg);
            const c = condense(text, query, budgetPer);
            if (c.length > digest.length) digest = c;
          } catch {
            /* page failed to load — fall back to the search snippet */
          }
          parts.push(`### ${r.title}\n${r.url}\n${digest}`);
        }
        ctx.log({ tool: "web_research", query, sources: parts.length });
        return {
          ok: true,
          output: `Digest for "${query}" (${parts.length} sources, condensed):\n\n${parts.join("\n\n")}`,
        };
      } catch (err) {
        return { ok: false, output: `web_research failed: ${(err as Error).message}` };
      }
    },
  };

  return [webSearch, webFetch, webResearch];
}

/** Fetch a URL and return its readable text (HTML → text). */
async function fetchReadable(url: string, cfg: WebConfig): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ctype = res.headers.get("content-type") || "";
  const raw = await res.text();
  return /html/i.test(ctype) ? htmlToText(raw) : raw;
}

/**
 * Extractive summariser: pick the sentences most relevant to `query` (with a
 * mild bias toward the top of the page) up to `maxChars`, preserving reading
 * order. No model call — keeps large pages from flooding the context. With no
 * query terms it falls back to the leading sentences (the article's lede).
 */
export function condense(text: string, query: string, maxChars: number): string {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30 && s.length <= 500);
  if (sentences.length === 0) return text.slice(0, maxChars);

  const terms = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2);
  const scored = sentences.map((s, i) => {
    const sl = s.toLowerCase();
    let score = 0;
    for (const t of terms) if (sl.includes(t)) score += 2;
    score += Math.max(0, 3 - i * 0.03); // earlier sentences are usually more informative
    return { s, i, score };
  });

  const picked: { s: string; i: number }[] = [];
  let len = 0;
  for (const x of [...scored].sort((a, b) => b.score - a.score)) {
    if (len + x.s.length + 1 > maxChars) continue;
    picked.push(x);
    len += x.s.length + 1;
  }
  if (picked.length === 0) return text.slice(0, maxChars);
  return picked
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s)
    .join(" ");
}

/* ── search providers ── */

async function search(query: string, cfg: WebConfig): Promise<SearchResult[]> {
  switch (cfg.provider) {
    case "tavily":
      return tavily(query, cfg);
    case "brave":
      return brave(query, cfg);
    case "searxng":
      return searxng(query, cfg);
    default:
      return duckduckgo(query, cfg);
  }
}

async function duckduckgo(query: string, cfg: WebConfig): Promise<SearchResult[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }).toString(),
  });
  const html = await res.text();

  // Two passes: titles+links, then snippets, zipped by order.
  const links: { title: string; url: string }[] = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const url = decodeDdgUrl(m[1]);
    const title = htmlToText(m[2]).trim();
    if (url && title) links.push({ title, url });
  }

  const snippets: string[] = [];
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = snipRe.exec(html)) !== null) snippets.push(htmlToText(m[1]).trim());

  return links.slice(0, cfg.maxResults).map((l, i) => ({ ...l, snippet: snippets[i] || "" }));
}

function decodeDdgUrl(href: string): string {
  // DDG wraps results as //duckduckgo.com/l/?uddg=<encoded>&...
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) return decodeURIComponent(m[1]);
  return href.startsWith("//") ? "https:" + href : href;
}

async function tavily(query: string, cfg: WebConfig): Promise<SearchResult[]> {
  if (!cfg.apiKey) throw new Error("Tavily requires web.api_key");
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: cfg.apiKey,
      query,
      max_results: cfg.maxResults,
      include_answer: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const json: any = await res.json();
  return (json?.results ?? [])
    .slice(0, cfg.maxResults)
    .map((r: any) => ({ title: r.title, url: r.url, snippet: r.content || "" }));
}

async function brave(query: string, cfg: WebConfig): Promise<SearchResult[]> {
  if (!cfg.apiKey) throw new Error("Brave requires web.api_key");
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${cfg.maxResults}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": cfg.apiKey },
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const json: any = await res.json();
  return (json?.web?.results ?? [])
    .slice(0, cfg.maxResults)
    .map((r: any) => ({ title: r.title, url: r.url, snippet: r.description || "" }));
}

async function searxng(query: string, cfg: WebConfig): Promise<SearchResult[]> {
  if (!cfg.searxngUrl) throw new Error("SearXNG requires web.searxng_url");
  const base = cfg.searxngUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const json: any = await res.json();
  return (json?.results ?? [])
    .slice(0, cfg.maxResults)
    .map((r: any) => ({ title: r.title, url: r.url, snippet: r.content || "" }));
}

/* ── html → text ── */

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#39": "'",
    apos: "'",
    nbsp: " ",
  };
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (_m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _m;
    }
    return named[code.toLowerCase()] ?? _m;
  });
}
