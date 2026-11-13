"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { SidebarGroup } from "./types";

export function Sidebar({ groups, onNavigate }: { groups: SidebarGroup[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Documentation" className="sidebar-nav">
      {groups.map((g) => (
        <div key={g.group} className="sidebar-group">
          <p className="sidebar-group-title">{g.group}</p>
          <ul>
            {g.pages.map((p) => {
              const active = pathname === p.href;
              return (
                <li key={p.slug}>
                  <Link
                    href={p.href}
                    aria-current={active ? "page" : undefined}
                    className={`sidebar-link${active ? " sidebar-link-active" : ""}`}
                    onClick={onNavigate}
                  >
                    {p.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
