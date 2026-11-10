import type { Metadata } from "next";
import { Landing } from "@/components/kinetic/landing";
import "@/components/carnival/journey.css";

export const metadata: Metadata = {
  title: "Valtrum — Find your people. Bring the big energy.",
  description:
    "Explore a living toy world, choose a token-community battle, and follow its 3D arena, chart and recorded outcome on NEAR testnet.",
};
export default function HomePage() {
  return <Landing />;
}
