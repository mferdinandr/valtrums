"use client";

import { FaucetPanel } from "@/components/faucet/faucet-panel";
import { CarnivalScene } from "@/components/carnival/scene";
import "@/components/lifecycle/lifecycle.css";

export default function FaucetPage() {
  return (
    <div className="lifecycle-page">
      <header className="arcade-heading arcade-heading--faucet">
        <div>
          <span className="arcade-kicker">TESTNET FAUCET</span>
          <h1>Pick up your tokens.</h1>
          <p>Claim community tokens once a day and join the action.</p>
        </div>
        <CarnivalScene mode="welcome" caption="The token stand" />
      </header>
      <FaucetPanel />
    </div>
  );
}
