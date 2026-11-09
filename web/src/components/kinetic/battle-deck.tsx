"use client";

import { useState } from "react";
import Link from "next/link";
import { KineticScene } from "./scene";
import { BattleEntrance } from "./battle-entrance";
import { DepositForm } from "@/components/deposit-form";
import { Countdown } from "@/components/countdown";
import { useNow } from "@/hooks/use-now";
import { formatUnits, toBigInt } from "@/lib/amounts";
import type { BattleView, Side, TokenMeta } from "@/lib/arena/types";
import type { DepositPhase } from "./battle-state";

const PHASES: Record<DepositPhase, string> = {
  idle: "Select a podium to back a community",
  preview: "Deposit preview · capsules are illustrative",
  review: "Review your deposit · nothing sent yet",
  pending: "Transaction pending · awaiting result",
  submitted: "Submitted · position credit not verified yet",
  success: "Position credit verified · vault secured",
  error: "Deposit failed · inspect the transaction before retrying",
};
const STATUS_COPY = {
  Proposed: "Waiting for audit. Vault gates are sealed.",
  Approved: "Gathering deposits. Choose your community.",
  Live: "Vaults locked. The timer ring follows the recorded battle interval.",
  Settling: "Settlement in progress. Inspect the execution steps below.",
  Settled: "Battle resolved. Manage your outcome in Portfolio.",
  EmergencyHalted: "Arena halted. Inspect your refund in Portfolio.",
  Voided: "Battle voided. Inspect your refund in Portfolio.",
};

export function BattleDeck({
  battle,
  metaA,
  metaB,
  lockedSide,
  depositOpen,
  positionLoading,
  onDone,
}: {
  battle: BattleView;
  metaA: TokenMeta;
  metaB: TokenMeta;
  lockedSide: Side | null;
  depositOpen: boolean;
  positionLoading: boolean;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<Side>("A");
  const [phase, setPhase] = useState<DepositPhase>("idle");
  const active = lockedSide ?? selected;
  const now = useNow(1000);
  const start = Number(toBigInt(battle.start_time_ns) / 1000000n);
  const end = Number(toBigInt(battle.end_time_ns) / 1000000n);
  const progress =
    end > start && now > 0
      ? Math.max(0, Math.min(1, (now - start) / (end - start)))
      : 0;
  const selectable =
    depositOpen &&
    !positionLoading &&
    phase !== "pending" &&
    phase !== "review";
  return (
    <section
      aria-label="Playable battle arena"
      className="relative overflow-hidden rounded-2xl border border-edge bg-[#161f26]"
    >
      <BattleEntrance
        id={battle.id}
        symbols={`${metaA.symbol} × ${metaB.symbol}`}
      />
      <div className="flex flex-wrap justify-between gap-3 border-b border-edge px-5 py-4">
        <div>
          <p className="eyebrow text-neon-green">
            Battle chamber / #{battle.id}
          </p>
          <p className="mt-2 text-xs text-mute">{STATUS_COPY[battle.status]}</p>
        </div>
        {battle.status === "Live" && (
          <div className="text-right font-mono text-neon-amber">
            <span className="block text-[9px] uppercase tracking-widest">
              Battle ends in
            </span>
            <Countdown targetNs={toBigInt(battle.end_time_ns)} />
          </div>
        )}
      </div>
      <div className="grid xl:grid-cols-[1.6fr_1fr]">
        <div className="relative min-w-0 bg-[radial-gradient(ellipse_at_center,#344a3433,transparent_70%)]">
          <div className="pointer-events-none absolute left-5 top-4 z-10 rounded border border-edge bg-void/70 px-3 py-2 text-[10px] uppercase tracking-wider text-mute">
            {battle.status === "Live"
              ? "Gates locked / timer active"
              : battle.status === "Settled"
                ? `Winner: ${battle.winner ?? "unavailable"}`
                : "Community selection deck"}
          </div>
          <KineticScene
            mode="battle"
            className="h-[390px] sm:h-[480px]"
            battle={{
              selected: active,
              onSelect: setSelected,
              selectable,
              lockedSide,
              phase,
              status: battle.status,
              winner: battle.winner,
              symbols: [metaA.symbol, metaB.symbol],
              progress,
            }}
          />
          <div className="grid grid-cols-2 gap-3 px-5 pb-5">
            {(["A", "B"] as const).map((s) => {
              const meta = s === "A" ? metaA : metaB;
              return (
                <button
                  key={s}
                  type="button"
                  disabled={
                    !selectable || (lockedSide !== null && lockedSide !== s)
                  }
                  aria-pressed={active === s}
                  onClick={() => setSelected(s)}
                  className={`rounded-xl border p-3 text-left transition-colors disabled:cursor-default ${active === s ? (s === "A" ? "border-neon-green/70 bg-neon-green/10" : "border-neon-pink/70 bg-neon-pink/10") : "border-edge bg-void/40"}`}
                >
                  <span className="eyebrow">
                    {active === s
                      ? "Selected"
                      : selectable && !lockedSide
                        ? "Select tribe " + s
                        : "Tribe " + s}
                  </span>
                  <span className="mt-1 block font-pixel text-lg">
                    {meta.symbol}
                  </span>
                  <span className="text-[11px] text-mute">
                    Vault{" "}
                    {formatUnits(
                      toBigInt(s === "A" ? battle.vault_a : battle.vault_b),
                      meta.decimals,
                      2,
                    )}{" "}
                    {meta.symbol}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div
          data-deck-controls
          className="border-t border-edge bg-void/40 p-5 xl:border-l xl:border-t-0"
        >
          <p className="eyebrow mb-3">Your control panel</p>
          <p
            role="status"
            className={`mb-5 min-h-10 text-sm ${phase === "error" ? "text-neon-red" : phase === "success" ? "text-neon-green" : "text-neon-amber"}`}
          >
            {depositOpen ? PHASES[phase] : STATUS_COPY[battle.status]}
          </p>
          {depositOpen ? (
            <DepositForm
              battle={battle}
              metaA={metaA}
              metaB={metaB}
              lockedSide={lockedSide}
              selectedSide={active}
              onSelectSide={setSelected}
              onVisualChange={setPhase}
              disabled={positionLoading}
              onDone={onDone}
            />
          ) : (
            <div className="space-y-4 rounded-xl border border-edge p-5">
              <h2 className="text-xl">
                {battle.status === "Settled"
                  ? "The outcome is recorded."
                  : "Vault access is closed."}
              </h2>
              <p className="text-sm leading-7 text-mute">
                {battle.status === "Live"
                  ? "No new deposits can enter this battle. Available performance and your position appear below."
                  : STATUS_COPY[battle.status]}
              </p>
              <Link
                className="inline-block rounded-lg border border-neon-green/40 px-4 py-3 text-xs text-neon-green"
                href="/portfolio"
              >
                Manage in Portfolio ↗
              </Link>
            </div>
          )}
          <p className="mt-5 text-[11px] leading-6 text-mute">
            Capsules visualize the deposit flow, not the number of token units.
            Vault amounts come from battle data. You can use the buttons instead
            of the 3D podiums.
          </p>
        </div>
      </div>
    </section>
  );
}
