import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Navbar } from "@/components/navbar";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "Valtrum | meme-coin liquidity warfare on NEAR",
  description: "Pick a tribe, back it with your coins, and take the loser's liquidity.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="scanlines min-h-screen">
        <Providers>
          <Navbar />
          <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        </Providers>
        <footer className="mx-auto max-w-6xl px-4 pb-10 font-pixel text-[8px] uppercase text-mute">
          Insert coin to continue. Testnet only.
        </footer>
      </body>
    </html>
  );
}
