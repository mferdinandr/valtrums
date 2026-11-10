"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { useApplicationDeployment } from "@/components/providers";
import { LifecycleTerminal } from "@/components/terminal/lifecycle-terminal";
import { CarnivalScene } from "@/components/carnival/scene";
import "@/components/lifecycle/lifecycle.css";

/** Intent terminal for the lifecycle contracts: create a battle, register, deposit or request a payout. */
export default function TerminalPage() {
  const deployment = useApplicationDeployment();
  return (
    <div className="lifecycle-page">
      <header className="lifecycle-hero">
        <div>
        <span className="lifecycle-pill">THE HELP KIOSK / INTENT TERMINAL</span>
        <h1>A little help with your next move.</h1>
        <p>
          Say what you want in plain English or Bahasa Indonesia. You always see the exact call first; nothing is sent to the action service until you ask for
          a preview, and only your wallet signs.
        </p>
        </div>
        <CarnivalScene mode="terminal" caption="Your command kiosk · you review, your wallet signs" />
      </header>
      {deployment ? (
        <LifecycleTerminal namespace={deployment} />
      ) : (
        <Card role="alert">
          Lifecycle reads are not configured for this deployment, so the terminal cannot review a request.{" "}
          <Link href="/arena" className="underline">
            Back to the battle list
          </Link>
        </Card>
      )}
    </div>
  );
}
