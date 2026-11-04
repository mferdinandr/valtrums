"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { config } from "@/lib/config";
import { WalletButton } from "@/components/wallet-button";

const LINKS = [
  { href: "/", label: "Arena" },
  { href: "/battles/new", label: "Create" },
  { href: "/portfolio", label: "Portfolio" },
];

export function Navbar() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b-2 border-edge bg-void/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
        <Link href="/" className="font-pixel text-sm text-neon-green drop-shadow-[0_0_6px_rgba(57,255,136,0.7)]">
          VALTRUM
        </Link>
        <span className="border-2 border-neon-amber px-2 py-1 font-pixel text-[8px] uppercase text-neon-amber">
          {config.mock ? "demo data" : config.network}
        </span>
        <nav className="flex flex-1 gap-1">
          {LINKS.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  "px-3 py-2 font-pixel text-[9px] uppercase",
                  active ? "bg-neon-pink/15 text-neon-pink" : "text-mute hover:text-ink",
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <WalletButton />
      </div>
    </header>
  );
}
