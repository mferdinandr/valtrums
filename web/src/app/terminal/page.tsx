"use client";

import { SessionPanel } from "@/components/terminal/session-panel";
import { TerminalPanel } from "@/components/terminal/terminal-panel";

export default function TerminalPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg text-neon-green">Intent terminal</h1>
        <p className="mt-2 text-xl text-mute">
          Say what you want in plain English or Bahasa Indonesia. You always see a summary first, and nothing is sent until you confirm.
        </p>
      </div>
      <TerminalPanel />
      <SessionPanel />
    </div>
  );
}
