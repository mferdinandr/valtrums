import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Navbar } from "@/components/navbar";
import { Providers } from "@/components/providers";
import { RouteFrame } from "@/components/kinetic/route-frame";

export const metadata: Metadata = {
  title: "Valtrum | meme-coin liquidity warfare on NEAR",
  description:
    "Pick a tribe, back it with your coins, and take the loser's liquidity.",
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
            className="mx-auto min-h-[75vh] max-w-[1440px] px-5 py-7 lg:px-10 lg:py-9"
          >
            <RouteFrame>{children}</RouteFrame>
          </main>
        </Providers>
        <footer className="mx-auto mt-12 flex max-w-[1440px] flex-wrap justify-between gap-3 border-t border-edge px-5 py-7 font-pixel text-[10px] uppercase tracking-wider text-mute lg:px-10">
          <span>Valtrum / Community-powered rivalry</span>
          <span>Built on NEAR · Testnet experience</span>
        </footer>
      </body>
    </html>
  );
}
