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
            An agent plays for you inside limits you set: one token, a per-action limit, a total budget and an end
            date. Your tokens stay in your account and you can revoke the grant at any time.
          </p>
          <div className="lifecycle-facts">
            <span>Your wallet signs</span>
            <span>Bounded budget</span>
            <span>Revocable</span>
          </div>
        </div>
        <CarnivalScene mode="terminal" caption="Your agent kiosk · decoration, not an agent's balance" />
      </header>
      <Card role="note" className="lifecycle-callout">
        <strong>What works today:</strong> creating a grant, reading its budget and revoking it. A running agent can
        propose a deposit and reserve budget. <strong>Not enabled yet:</strong> an agent cannot move tokens on its own,
        because executing a reserved deposit is still an open decision in the project docs.
      </Card>
      {namespace ? <AgentGrants namespace={namespace} /> : <Card role="alert">The arena deployment is not configured.</Card>}
    </div>
  );
}
