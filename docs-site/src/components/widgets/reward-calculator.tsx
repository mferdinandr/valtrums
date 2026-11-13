"use client";

import { useState } from "react";

const FEE_BPS = 10;
const CREATOR_SHARE_BPS = 5000;

export function RewardCalculator() {
  const [mine, setMine] = useState(600);
  const [team, setTeam] = useState(1000);
  const [losing, setLosing] = useState(100000);
  const [protocolCreated, setProtocolCreated] = useState(false);
  const safeTeam = Math.max(team, 1);
  const safeMine = Math.min(Math.max(mine, 0), safeTeam);
  const fee = Math.floor((losing * FEE_BPS) / 10000);
  const creatorFee = protocolCreated ? 0 : Math.floor((fee * CREATOR_SHARE_BPS) / 10000);
  const protocolFee = fee - creatorFee;
  const pool = losing - fee;
  const yours = Math.floor((pool * safeMine) / safeTeam);
  const rows: [string, number][] = [
    [`Your share (${((safeMine / safeTeam) * 100).toFixed(2)}% of the winners' pool)`, yours],
    ["Winners' pool (99.9%)", pool],
    ["Creator fee", creatorFee],
    ["Protocol fee", protocolFee],
  ];
  return (
    <div className="widget">
      <div className="widget-fields">
        <label className="widget-field">
          Your deposit
          <input type="number" min={0} value={mine} onChange={(e) => setMine(Number(e.target.value) || 0)} className="widget-input" />
        </label>
        <label className="widget-field">
          Winning community total
          <input type="number" min={1} value={team} onChange={(e) => setTeam(Number(e.target.value) || 1)} className="widget-input" />
        </label>
        <label className="widget-field">
          Losing community deposit
          <input
            type="number"
            min={0}
            value={losing}
            onChange={(e) => setLosing(Math.max(Number(e.target.value) || 0, 0))}
            className="widget-input"
          />
        </label>
      </div>
      <label className="widget-check">
        <input type="checkbox" checked={protocolCreated} onChange={(e) => setProtocolCreated(e.target.checked)} />
        Battle created by the protocol
      </label>
      <div className="widget-rows" aria-live="polite">
        {rows.map(([label, value], i) => (
          <div key={label} className={`widget-row${i === 0 ? " widget-row-main" : ""}`}>
            <span>{label}</span>
            <strong>{value.toLocaleString("en-US")}</strong>
          </div>
        ))}
      </div>
      <div className="widget-hint">
        Amounts are in whole units of the losing token, at the default fee of 0.1% and creator share of 50%.
      </div>
    </div>
  );
}
