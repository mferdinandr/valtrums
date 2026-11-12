"use client";

import { useState } from "react";
import { AgentGrants } from "@/components/agents/agent-grants";
import { AutonomousAgent } from "@/components/agents/autonomous-agent";
import { HostedAgent } from "@/components/agents/hosted-agent";
import { config } from "@/lib/config";
import { CarnivalScene } from "@/components/carnival/scene";
import { Card } from "@/components/ui/card";
import { useApplicationDeployment } from "@/components/providers";
import { cn } from "@/lib/utils";
import "@/components/lifecycle/lifecycle.css";

type Mode = "new" | "budget";

const MODES: ReadonlyArray<{ id: Mode; title: string; text: string }> = [
  { id: "new", title: "New agent", text: "Create an agent with its own wallet. You fund it and it plays by itself." },
  { id: "budget", title: "Budget for my agent", text: "Already run an agent? Give it a capped budget from your account. It can only suggest deposits; it cannot move your tokens." },
];

export default function AgentsPage() {
  const namespace = useApplicationDeployment();
  const [mode, setMode] = useState<Mode>("new");
  return (
    <div className="lifecycle-page">
      <header className="arcade-heading arcade-heading--agents">
        <div>
          <span className="arcade-kicker">PLAYER AGENTS</span>
          <h1>Your agents, your rules.</h1>
          <p className="text-sm text-mute">
            An agent plays battles for you. Pick how you want to set one up. You stay in control and can stop it at any time.
          </p>
        </div>
        <CarnivalScene mode="terminal" caption="Your agent kiosk" />
      </header>
      {namespace ? (
        <>
          <div role="tablist" aria-label="Agent setup" className="grid gap-3 sm:grid-cols-2">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={mode === m.id}
                onClick={() => setMode(m.id)}
                className={cn(
                  "rounded-xl border p-4 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-neon-green/20",
                  mode === m.id ? "border-neon-green bg-neon-green/10" : "border-edge hover:border-neon-green/60",
                )}
              >
                <strong className="block text-sm font-semibold">{m.title}</strong>
                <span className="mt-1 block text-xs text-mute">{m.text}</span>
              </button>
            ))}
          </div>
          {mode === "budget" ? (
            <AgentGrants namespace={namespace} />
          ) : config.hostedAgentsUrl ? (
            <>
              <HostedAgent namespace={namespace} />
              <details className="lifecycle-tech">
                <summary>Advanced: run an agent yourself</summary>
                <div className="mt-3">
                  <AutonomousAgent namespace={namespace} />
                </div>
              </details>
            </>
          ) : (
            <AutonomousAgent namespace={namespace} />
          )}
        </>
      ) : (
        <Card role="alert">Agents are currently unavailable. Please try again later.</Card>
      )}
    </div>
  );
}
