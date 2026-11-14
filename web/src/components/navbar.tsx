"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { WalletButton } from "@/components/wallet-button";
import { MusicToggle } from "@/components/music-toggle";
import { Bot, BookOpen, Droplets, Swords, Layers3, Sparkles, Plus } from "lucide-react";
import { Brand } from "@/components/brand";
import { arenaNavigationActive } from "@/lib/arena-read/routes";

const LINKS = [
  { href: "/arena", label: "Arena", icon: Swords },
  {
    href: "/arena/new",
    label: "Create",
    icon: Plus,
  },
  { href: "/terminal", label: "Assistant", icon: Sparkles },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/faucet", label: "Faucet", icon: Droplets },
  { href: "/portfolio", label: "Portfolio", icon: Layers3 },
];

const DOCS_URL = "https://docs.valtrums.xyz";

const LINK_CLASS =
  "site-nav-link flex min-h-11 shrink-0 items-center gap-1.5 px-3 py-2 font-pixel text-xs transition-colors md:gap-2 md:px-4 md:text-xs";

export function Navbar() {
  const pathname = usePathname();
  return (
    <header
      className={
        pathname === "/"
          ? "site-header site-header-home fixed inset-x-0 top-0 z-40"
          : "site-header sticky top-0 z-40"
      }
    >
      <div className="mx-auto flex max-w-[1680px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 lg:px-8">
        <Link
          href="/"
          className="flex items-center gap-2.5 font-pixel text-xl font-bold tracking-[-.06em]"
        >
          <Brand />
        </Link>
        <nav
          aria-label="Main navigation"
          className="order-3 flex w-full gap-1 overflow-x-auto md:order-none md:w-auto md:flex-1 md:justify-center"
        >
          {LINKS.map((l) => {
            const active =
              l.href === "/arena"
                ? arenaNavigationActive(pathname)
                : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  LINK_CLASS,
                  active
                    ? "site-nav-active"
                    : "text-mute hover:bg-white/60 hover:text-ink",
                )}
              >
                <l.icon size={14} /> {l.label}
              </Link>
            );
          })}
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(LINK_CLASS, "text-mute hover:bg-white/60 hover:text-ink")}
          >
            <BookOpen size={14} /> Docs
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <MusicToggle />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
