"use client";

import { FaucetPanel } from "@/components/faucet/faucet-panel";
import { CarnivalScene } from "@/components/carnival/scene";
import "@/components/lifecycle/lifecycle.css";

export default function FaucetPage() {
  return (
    <div className="lifecycle-page">
      <header className="lifecycle-hero">
        <div>
          <span className="lifecycle-pill">TESTNET FAUCET</span>
          <h1>
            Get test tokens.
            <br />
            Join a battle.
          </h1>
          <p className="text-sm text-mute">
            Claim a small amount of each community token on NEAR testnet, once a day per token. You only need a NEAR
            testnet account; the faucet registers your storage for you.
          </p>
          <div className="lifecycle-facts">
            <span>No EVM wallet needed</span>
            <span>Backed 1:1</span>
            <span>Testnet only</span>
          </div>
        </div>
        <CarnivalScene mode="welcome" caption="The token stand" />
      </header>
      <FaucetPanel />
    </div>
  );
}
