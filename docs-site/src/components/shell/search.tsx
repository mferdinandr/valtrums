"use client";

import { useRouter } from "next/navigation";
import { Search as SearchIcon, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchItem } from "./types";

interface Hit {
  item: SearchItem;
  score: number;
  snippet: string;
}

function snippetOf(text: string, term: string): string {
  const at = text.toLowerCase().indexOf(term);
  if (at < 0) return "";
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + term.length + 90);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function search(items: SearchItem[], query: string): Hit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const hits: Hit[] = [];
  for (const item of items) {
    const title = item.title.toLowerCase();
    const description = item.description.toLowerCase();
    const keywords = item.keywords.join(" ").toLowerCase();
    const text = item.text.toLowerCase();
    let score = 0;
    let matchedAll = true;
    for (const t of terms) {
      const s =
        (title.includes(t) ? 10 : 0) + (keywords.includes(t) ? 5 : 0) + (description.includes(t) ? 3 : 0) + (text.includes(t) ? 1 : 0);
      if (s === 0) matchedAll = false;
      score += s;
    }
    if (matchedAll) hits.push({ item, score, snippet: snippetOf(item.text, terms[0] ?? "") });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 8);
}

export function Search({ items }: { items: SearchItem[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const hits = useMemo(() => search(items, query), [items, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setCursor(0);
      input.current?.focus();
    }
  }, [open]);

  const go = (href: string) => {
    setOpen(false);
    setQuery("");
    router.push(href);
  };

  return (
    <>
      <button type="button" className="search-trigger" onClick={() => setOpen(true)}>
        <SearchIcon size={15} aria-hidden />
        <span>Search docs</span>
        <kbd>⌘K</kbd>
      </button>
      {open && (
        <div className="search-backdrop" onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Search the documentation"
            className="search-dialog"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, Math.max(hits.length - 1, 0)));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              }
              const hit = hits[cursor];
              if (e.key === "Enter" && hit) go(hit.item.href);
            }}
          >
            <div className="search-input-row">
              <SearchIcon size={18} aria-hidden />
              <input
                ref={input}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
                placeholder="Search battles, rewards, agents…"
                aria-label="Search"
              />
              <button type="button" className="search-close" aria-label="Close search" onClick={() => setOpen(false)}>
                <X size={16} />
              </button>
            </div>
            {query && (
              <ul className="search-results" role="listbox">
                {hits.length === 0 && <li className="search-empty">No results for “{query}”.</li>}
                {hits.map((hit, i) => (
                  <li key={hit.item.href} role="option" aria-selected={i === cursor}>
                    <button
                      type="button"
                      className="search-hit"
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => go(hit.item.href)}
                    >
                      <span className="search-hit-group">{hit.item.group}</span>
                      <span className="search-hit-title">{hit.item.title}</span>
                      <span className="search-hit-snippet">{hit.snippet || hit.item.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}
