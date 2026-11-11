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
      <header className="arcade-heading arcade-heading--terminal">
        <div>
        <span className="arcade-kicker">TERMINAL</span>
        <h1>What’s your next move?</h1>
        <p>
          Ask in English or Bahasa Indonesia. Review your action before signing.
        </p>
        </div>
        <CarnivalScene mode="terminal" caption="Your command kiosk" />
      </header>
      {deployment ? (
        <LifecycleTerminal namespace={deployment} />
      ) : (
        <Card role="alert">
          The assistant is currently unavailable. Please try again later.{" "}
          <Link href="/arena" className="underline">
            Back to the battle list
          </Link>
        </Card>
      )}
    </div>
  );
}
