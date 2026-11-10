"use client";

import { AgentGrants } from "@/components/agents/agent-grants";
import { CarnivalScene } from "@/components/carnival/scene";
import { Card } from "@/components/ui/card";
import { useApplicationDeployment } from "@/components/providers";
import "@/components/lifecycle/lifecycle.css";

export default function AgentsPage() {
  const namespace = useApplicationDeployment();
  return (
    <div className="lifecycle-page">
      <header className="lifecycle-hero">
        <div>
          <span className="lifecycle-pill">YOUR PLAYER AGENTS</span>
          <h1>
            Give an agent a budget.
            <br />
            Keep the keys.
          </h1>
          <p className="text-sm text-mute">
            Set a token, spending limits and an end date for your agent. You can revoke access at any time.
            Your agent can suggest deposits, but cannot move tokens on its own.
          </p>
          <div className="lifecycle-facts">
            <span>Your wallet signs</span>
            <span>Bounded budget</span>
            <span>Revocable</span>
          </div>
        </div>
        <CarnivalScene mode="terminal" caption="Your agent kiosk · decoration, not an agent's balance" />
      </header>
      {namespace ? <AgentGrants namespace={namespace} /> : <Card role="alert">Agents are currently unavailable. Please try again later.</Card>}
    </div>
  );
}
