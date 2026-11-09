"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { config } from "@/lib/config";
import { WalletButton } from "@/components/wallet-button";
import {
  Aperture,
  Swords,
  Layers3,
  Terminal,
  Plus,
} from "lucide-react";

const LINKS = [
  { href: "/arena", label: "Arena", icon: Swords },
  { href: "/battles/new", label: "Create", icon: Plus },
  { href: "/terminal", label: "Terminal", icon: Terminal },
  { href: "/portfolio", label: "Portfolio", icon: Layers3 },
];

export function Navbar() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-edge/70 bg-void/95 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4 lg:px-10">
        <Link
          href="/"
          className="flex items-center gap-2.5 font-pixel text-xl font-bold tracking-[-.06em]"
        >
          <Aperture size={28} strokeWidth={1.5} className="text-neon-green" />{" "}
          VALTRUM<span className="text-xs text-neon-green">✳</span>
        </Link>
        <span className="hidden items-center gap-2 rounded-full border border-edge px-2.5 py-1.5 font-pixel text-[9px] uppercase tracking-wider text-mute sm:inline-flex">
          <span className="status-dot" />
          {config.mock ? "demo data" : config.network}
        </span>
        <nav
          aria-label="Main navigation"
          className="order-3 flex w-full gap-1 overflow-x-auto md:order-none md:w-auto md:flex-1 md:justify-center"
        >
          {LINKS.map((l) => {
              const active =
                l.href === "/arena"
                  ? pathname === "/arena" ||
                    (pathname.startsWith("/battles/") &&
                      pathname !== "/battles/new")
                  : pathname.startsWith(l.href);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-10 items-center gap-1.5 rounded-lg px-2 py-2 font-pixel text-[11px] transition-colors md:gap-2 md:px-3 md:text-xs",
                    active
                      ? "bg-neon-green/10 text-neon-green"
                      : "text-mute hover:bg-white/5 hover:text-ink",
                  )}
                >
                  <l.icon size={14} /> {l.label}
                </Link>
              );
            })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
