import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ALL_SLUGS, groupOf } from "./navigation";

export interface Frontmatter {
  title: string;
  description: string;
  sidebarTitle?: string;
  keywords: string[];
}

export interface PageSource {
  slug: string;
  group: string;
  frontmatter: Frontmatter;
  /** The whole file, frontmatter included. */
  raw: string;
}

export interface SearchEntry {
  slug: string;
  group: string;
  title: string;
  description: string;
  keywords: string[];
  text: string;
}

const CONTENT_DIR = path.join(process.cwd(), "content");

function parseFrontmatter(raw: string, slug: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!match?.[1]) throw new Error(`content/${slug}.mdx has no frontmatter`);
  const fields: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    // Values are written as JSON strings or JSON arrays.
    fields[key] = value.startsWith('"') || value.startsWith("[") ? JSON.parse(value) : value;
  }
  const { title, description, sidebarTitle, keywords } = fields;
  if (typeof title !== "string" || typeof description !== "string") {
    throw new Error(`content/${slug}.mdx needs a title and a description`);
  }
  return {
    title,
    description,
    sidebarTitle: typeof sidebarTitle === "string" ? sidebarTitle : undefined,
    keywords: Array.isArray(keywords) ? keywords.filter((k): k is string => typeof k === "string") : [],
  };
}

const cache = new Map<string, PageSource>();

export function getPage(slug: string): PageSource {
  const hit = cache.get(slug);
  if (hit) return hit;
  if (!ALL_SLUGS.includes(slug)) throw new Error(`Unknown page: ${slug}`);
  const raw = readFileSync(path.join(CONTENT_DIR, `${slug}.mdx`), "utf8");
  const page: PageSource = { slug, group: groupOf(slug) ?? "", frontmatter: parseFrontmatter(raw, slug), raw };
  cache.set(slug, page);
  return page;
}

export function getAllPages(): PageSource[] {
  return ALL_SLUGS.map(getPage);
}

/** Readable body text without frontmatter, JSX tags or Markdown syntax, for search. */
function plainText(raw: string): string {
  return raw
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*#|>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getSearchIndex(): SearchEntry[] {
  return getAllPages().map((p) => ({
    slug: p.slug,
    group: p.group,
    title: p.frontmatter.sidebarTitle ?? p.frontmatter.title,
    description: p.frontmatter.description,
    keywords: p.frontmatter.keywords,
    text: plainText(p.raw),
  }));
}
