"use client";

import { TargetFlow } from "@/components/target-flow";
import { FlowNotice } from "@/components/flow-notice";
import { SessionPanel } from "@/components/terminal/session-panel";
import { TerminalPanel } from "@/components/terminal/terminal-panel";

export default function TerminalPage() {
  return (
    <div className="space-y-6">
      <FlowNotice compact />
      <TargetFlow page="terminal" />
      <div>
        <h1 className="text-lg text-neon-green">Intent terminal</h1>
        <p className="mt-2 text-xl text-mute">
          Say what you want in plain English or Bahasa Indonesia. You always see a summary first, and nothing is sent until you confirm.
        </p>
        <p className="mt-2 text-lg text-mute">
          Approvals: funding your arena balance takes one wallet approval. Deposits paid from that balance need none while a valid session key exists;
          without one, each deposit asks your wallet once.
        </p>
      </div>
      <TerminalPanel />
      <SessionPanel />
    </div>
  );
}
