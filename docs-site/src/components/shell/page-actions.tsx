"use client";

import { Check, ChevronDown, Copy, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** Copy the page as Markdown, view it, or open it in an AI assistant. */
export function PageActions({ markdownPath, pageUrl }: { markdownPath: string; pageUrl: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const copy = async () => {
    try {
      const res = await fetch(markdownPath);
      if (!res.ok) throw new Error(String(res.status));
      await navigator.clipboard.writeText(await res.text());
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  };

  const prompt = encodeURIComponent(`Read from ${pageUrl} so I can ask questions about it.`);
  const assistants = [
    { label: "Open in ChatGPT", href: `https://chatgpt.com/?hints=search&q=${prompt}` },
    { label: "Open in Claude", href: `https://claude.ai/new?q=${prompt}` },
    { label: "Open in Perplexity", href: `https://www.perplexity.ai/search/new?q=${prompt}` },
  ];

  return (
    <div className="page-actions" ref={menu}>
      <button type="button" className="page-action" onClick={copy}>
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {copied ? "Copied" : failed ? "Copy failed" : "Copy page"}
      </button>
      <button
        type="button"
        className="page-action page-action-more"
        aria-label="More page options"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="page-actions-menu" role="menu">
          <a role="menuitem" href={markdownPath} target="_blank" rel="noopener noreferrer">
            <FileText size={14} aria-hidden /> View as Markdown
          </a>
          {assistants.map((a) => (
            <a key={a.label} role="menuitem" href={a.href} target="_blank" rel="noopener noreferrer">
              {a.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
