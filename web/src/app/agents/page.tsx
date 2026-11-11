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
      <header className="arcade-heading arcade-heading--agents">
        <div>
          <span className="arcade-kicker">PLAYER AGENTS</span>
          <h1>Your agents, your rules.</h1>
          <p className="text-sm text-mute">
            Set a token, spending limits and an end date for your agent. You can revoke access at any time.
            Your agent can suggest deposits, but cannot move tokens on its own.
          </p>
        </div>
        <CarnivalScene mode="terminal" caption="Your agent kiosk" />
      </header>
      {namespace ? <AgentGrants namespace={namespace} /> : <Card role="alert">Agents are currently unavailable. Please try again later.</Card>}
    </div>
  );
}
