"use client";

import { SessionPanel } from "@/components/terminal/session-panel";
import { TerminalPanel } from "@/components/terminal/terminal-panel";
import { CarnivalScene } from "@/components/carnival/scene";

export default function TerminalPage() {
  return (
    <div className="space-y-6">
      <div className="page-heading">
        <p className="eyebrow">THE HELP KIOSK / INTENT TERMINAL</p>
        <h1>A little help with your next move.</h1>
        <p>
          Say what you want in plain English or Bahasa Indonesia. You always see
          a summary first, and nothing is sent until you confirm.
        </p>
      </div>
      <div className="carnival-workspace">
        <div className="space-y-6">
          <TerminalPanel />
          <p className="carnival-note">
            Approvals: funding your arena balance takes one wallet approval.
            Deposits paid from that balance need none while a valid session key
            exists; without one, each deposit asks your wallet once.
          </p>
        </div>
        <aside className="space-y-5">
          <div className="carnival-workspace-aside !static">
            <CarnivalScene mode="terminal" className="!h-[280px]" />
            <div className="carnival-aside-copy">
              <span className="eyebrow text-neon-pink">
                YOUR WORDS. YOUR APPROVAL.
              </span>
              <h2 className="mt-3">Ask. Review. Confirm.</h2>
              <p>
                The kiosk mascot is decorative. The summary, funding route and
                wallet permissions below determine what gets sent.
              </p>
            </div>
          </div>
          <SessionPanel />
        </aside>
      </div>
    </div>
  );
}
