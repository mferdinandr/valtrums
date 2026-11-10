import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";
import { Navbar } from "@/components/navbar";
import { Providers } from "@/components/providers";
import { RouteFrame } from "@/components/kinetic/route-frame";

export const metadata: Metadata = {
  title: "Valtrum | A little rivalry. Big community energy.",
  description:
    "A playful fairground for token communities. Explore battles, meet original 3D mascots and review every action before signing.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <a
          href="#main-content"
          className="fixed left-4 top-4 z-50 -translate-y-24 rounded bg-neon-green p-3 text-void focus:translate-y-0"
        >
          Skip to content
        </a>
        <Providers>
          <Navbar />
          <main
            id="main-content"
            className="site-main mx-auto min-h-[75vh] max-w-[1360px] px-5 py-7 lg:px-10 lg:py-9"
          >
            <RouteFrame>{children}</RouteFrame>
          </main>
        </Providers>
        <footer className="site-footer">
          <div>
            <strong>Valtrum ✳</strong>
            <p>A little rivalry. A lot of community.</p>
          </div>
          <nav aria-label="Footer navigation">
            <Link href="/arena">Battles</Link>
            <Link href="/arena/preview">3D playground</Link>
            <Link href="/portfolio">Portfolio</Link>
          </nav>
          <p>Built on NEAR · Testnet experience</p>
        </footer>
      </body>
    </html>
  );
}
