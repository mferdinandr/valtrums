"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Brand } from "./brand";
import { GithubIcon } from "./github-icon";
import { Search } from "./search";
import { Sidebar } from "./sidebar";
import type { SearchItem, SidebarGroup } from "./types";

export function SiteHeader({
  groups,
  searchItems,
  appUrl,
  githubUrl,
}: {
  groups: SidebarGroup[];
  searchItems: SearchItem[];
  appUrl: string;
  githubUrl: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <button
          type="button"
          className="menu-toggle"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          {menuOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
        <Link href="/" aria-label="Valtrums docs home" className="brand-link">
          <Brand />
        </Link>
        <div className="header-search">
          <Search items={searchItems} />
        </div>
        <div className="header-actions">
          <a href={githubUrl} target="_blank" rel="noopener noreferrer" className="header-link" aria-label="GitHub">
            <GithubIcon size={16} />
            <span>GitHub</span>
          </a>
          <a href={appUrl} target="_blank" rel="noopener noreferrer" className="header-cta">
            Open app <ArrowUpRight size={14} aria-hidden />
          </a>
        </div>
      </div>
      {menuOpen && (
        <div className="mobile-nav">
          <Sidebar groups={groups} onNavigate={() => setMenuOpen(false)} />
        </div>
      )}
    </header>
  );
}
