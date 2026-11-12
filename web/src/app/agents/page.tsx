"use client";

import { AutonomousAgent } from "@/components/agents/autonomous-agent";
import { HostedAgent } from "@/components/agents/hosted-agent";
import { config } from "@/lib/config";
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
            Create an agent with its own wallet that plays battles by itself. You fund it, and you can stop it at any time.
          </p>
        </div>
        <CarnivalScene mode="terminal" caption="Your agent kiosk" />
      </header>
      {namespace ? (
        config.hostedAgentsUrl ? (
          <>
            <HostedAgent namespace={namespace} />
            {/* Kept mounted inside the closed details so a key made here is not lost when the section is folded. */}
            <details className="lifecycle-tech">
              <summary>Advanced: run an agent yourself</summary>
              <div className="mt-3">
                <AutonomousAgent namespace={namespace} />
              </div>
            </details>
          </>
        ) : (
          <AutonomousAgent namespace={namespace} />
        )
      ) : (
        <Card role="alert">Agents are currently unavailable. Please try again later.</Card>
      )}
    </div>
  );
}
