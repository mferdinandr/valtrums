"use client";

import { useState } from "react";

const STEPS = [
  { label: "Open", detail: "The creator picks one scoring mode and a start time between 1 minute and 7 days away. There is no bond, and the creator must deposit before the lock." },
  { label: "Join and deposit", detail: "Until the start time, anyone joins with CASHCAT, WALLET, GOOD, VLAD or DEGEN and deposits. A deposit counts once its tokens arrive and the community is approved." },
  { label: "Lock", detail: "At the start time, with two or more funded communities, everything is frozen. With fewer than two, anyone can cancel and depositors get refunds." },
  { label: "Rounds", detail: "Each round lasts exactly 30 seconds and is scored with the chosen mode from recorded prices. A unique best score wins." },
  { label: "Overtime", detail: "Tied leaders play again with every input reset. There is no cap on overtime rounds, and all deposits stay locked." },
  { label: "Settlement", detail: "Each losing deposit pays 99.9% to the winning backers, 0.05% to the creator and 0.05% to the protocol, in the original token." },
  { label: "Winners' vote", detail: "The winning community's own deposit sits in escrow while its backers vote on how much to burn and how much to return." },
];

export function BattleStages() {
  const [active, setActive] = useState(0);
  return (
    <div className="widget">
      <div className="stage-grid">
        {STEPS.map((step, i) => (
          <button
            key={step.label}
            type="button"
            onClick={() => setActive(i)}
            aria-pressed={i === active}
            className={`stage-button${i > active ? " stage-ahead" : ""}`}
          >
            <span className="stage-number">Stage {i + 1}</span>
            <span className="stage-label">{step.label}</span>
          </button>
        ))}
      </div>
      <p className="stage-detail" aria-live="polite">
        {STEPS[active]?.detail}
      </p>
      <div className="widget-actions">
        <button type="button" className="widget-button" disabled={active === 0} onClick={() => setActive(active - 1)}>
          Back
        </button>
        <button
          type="button"
          className="widget-button widget-button-primary"
          disabled={active === STEPS.length - 1}
          onClick={() => setActive(active + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
