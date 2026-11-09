import type { Metadata } from "next";
import { Landing } from "@/components/kinetic/landing";

export const metadata: Metadata = {
  title: "Valtrum — Your tribe. Their liquidity.",
  description:
    "Explore token-community battles. Try a wallet-free practice round, learn the mechanics, then enter Valtrum on NEAR testnet.",
};
export default function HomePage() {
  return <Landing />;
}
