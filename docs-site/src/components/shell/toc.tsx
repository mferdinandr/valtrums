"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

interface Entry {
  id: string;
  text: string;
  level: number;
}

/** "On this page": built from the rendered h2/h3 headings, with the visible one highlighted. */
export function Toc() {
  const pathname = usePathname();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const headings = Array.from(document.querySelectorAll<HTMLHeadingElement>(".doc-body h2[id], .doc-body h3[id]"));
    setEntries(headings.map((h) => ({ id: h.id, text: h.textContent ?? "", level: h.tagName === "H3" ? 3 : 2 })));
    setActiveId(headings[0]?.id ?? null);
    if (headings.length === 0) return;
    const observer = new IntersectionObserver(
      (records) => {
        const visible = records.filter((r) => r.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: "-90px 0px -65% 0px" },
    );
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [pathname]);

  if (entries.length === 0) return null;
  return (
    <nav aria-label="On this page" className="toc">
      <p className="toc-title">On this page</p>
      <ul>
        {entries.map((e) => (
          <li key={e.id} className={e.level === 3 ? "toc-sub" : undefined}>
            <a href={`#${e.id}`} className={e.id === activeId ? "toc-active" : undefined}>
              {e.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
