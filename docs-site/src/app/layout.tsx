import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";
import { getPage, getSearchIndex } from "@/lib/content";
import { APP_URL, GITHUB_URL, NAVIGATION, SITE_URL, hrefOf } from "@/lib/navigation";
import { Brand } from "@/components/shell/brand";
import { SiteHeader } from "@/components/shell/site-header";
import { Sidebar } from "@/components/shell/sidebar";
import type { SearchItem, SidebarGroup } from "@/components/shell/types";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Valtrums Docs", template: "%s - Valtrums" },
  description: "Valtrums is an open arena where token communities compete in 30-second rounds. Winners receive the losing communities' original tokens.",
  icons: { icon: "/valtrum-logo.png" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const groups: SidebarGroup[] = NAVIGATION.map((g) => ({
    group: g.group,
    pages: g.pages.map((slug) => {
      const fm = getPage(slug).frontmatter;
      return { slug, href: hrefOf(slug), label: fm.sidebarTitle ?? fm.title };
    }),
  }));
  const searchItems: SearchItem[] = getSearchIndex().map(({ slug, ...rest }) => ({ href: hrefOf(slug), ...rest }));

  return (
    <html lang="en">
      <body>
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <SiteHeader groups={groups} searchItems={searchItems} appUrl={APP_URL} githubUrl={GITHUB_URL} />
        <div className="docs-shell">
          <aside className="docs-sidebar">
            <Sidebar groups={groups} />
          </aside>
          <main id="main-content" className="docs-main">
            {children}
          </main>
        </div>
        <footer className="site-footer">
          <div>
            <Link href="/" aria-label="Valtrums docs home">
              <Brand />
            </Link>
            <p>A little rivalry. A lot of community.</p>
          </div>
          <nav aria-label="Footer navigation">
            <a href={APP_URL}>Open app</a>
            <Link href="/quickstart">Quickstart</Link>
            <Link href="/reference/faq">FAQ</Link>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
          </nav>
          <p>Built on NEAR · Testnet experience</p>
        </footer>
      </body>
    </html>
  );
}
