import type { Metadata } from "next";
import { Landing } from "@/components/kinetic/landing";
import "@/components/carnival/journey.css";

export const metadata: Metadata = {
  title: "Valtrum — Find your people. Bring the big energy.",
  description:
    "Meet original toy mascots, explore token-community battles, and try the wallet-free Token Carnival on NEAR testnet.",
};
export default function HomePage() {
  return <Landing />;
}
