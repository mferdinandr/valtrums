import type { Metadata } from "next";
import { ColosseumPreview } from "@/components/colosseum/preview";
import "@/components/colosseum/colosseum.css";

export const metadata: Metadata = {
  title: "Token Carnival — Valtrum playable preview",
  description:
    "A cheerful 3D community carnival with five original toy mascots and personal reactor challenges. Thirty-second performance rounds and leader-only overtime. Scripted fixtures, no transactions.",
};

export default function ColosseumPage() {
  return <ColosseumPreview />;
}
