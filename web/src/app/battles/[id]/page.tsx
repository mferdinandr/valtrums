"use client";

import { use } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { Countdown } from "@/components/countdown";
import { DepositForm } from "@/components/deposit-form";
import { HpBar } from "@/components/hp-bar";
import { useArena, useWallet } from "@/components/providers";
import { StatusTimeline } from "@/components/status-timeline";
import { TerminalPanel } from "@/components/terminal/terminal-panel";
import { useAsync } from "@/hooks/use-async";
import { useNow } from "@/hooks/use-now";
import { useTokenMetas } from "@/hooks/use-token-metas";
import { formatBps, formatUnits, formatUsdc, leader, msUntilNs, performanceBps, toBigInt } from "@/lib/amounts";
import { previewWinnerPayout, priceBasis, vaultsInUsdc } from "@/lib/arena/payout";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/arena/status";
import type { BattleView, Side, TokenMeta } from "@/lib/arena/types";

function Tribe({
  side,
  token,
  meta,
  vault,
  usdc,
  winner,
  bps,
}: {
  side: Side;
  token: string;
  meta: TokenMeta;
  vault: bigint;
  usdc: bigint | null;
  winner: boolean;
  bps: bigint | null;
}) {
  const tone = side === "A" ? "cyan" : "pink";
  return (
    <Card className={winner ? "border-neon-green shadow-glow-green" : undefined}>
      <div className="flex items-center justify-between">
        <Badge tone={tone}>Tribe {side}</Badge>
        {winner && <Badge tone="green">Winner</Badge>}
      </div>
      <h2 className={`mt-3 text-lg ${side === "A" ? "text-neon-cyan" : "text-neon-pink"}`}>{meta.symbol}</h2>
      <p className="break-all text-base text-mute">{token}</p>
      <dl className="mt-3 space-y-1 text-xl">
        <div className="flex justify-between">
          <dt className="text-mute">Vault</dt>
          <dd>
            {formatUnits(vault, meta.decimals, 2)} {meta.symbol}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-mute">Value</dt>
          <dd>{usdc === null ? "--" : formatUsdc(usdc)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-mute">Performance</dt>
          <dd className={bps === null ? "" : bps >= 0n ? "text-neon-green" : "text-neon-red"}>
            {bps === null ? "--" : formatBps(bps)}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function perfPercent(bps: bigint | null): number {
  // Map -20%..+20% onto the full meter, 0% in the middle.
  return bps === null ? 50 : 50 + Number(bps) / 40;
}

function Detail({ battle, reload }: { battle: BattleView; reload: () => void }) {
  const api = useArena();
  const { accountId } = useWallet();
  const now = useNow(1000);
  const metas = useTokenMetas([battle.token_a, battle.token_b]);
  const metaA = metas[battle.token_a]!;
  const metaB = metas[battle.token_b]!;

  const live = useAsync(() => api.getLivePrices(battle.id), [api, battle.id, battle.status]);
  const plan = useAsync(() => api.getSettlementPlan(battle.id), [api, battle.id, battle.status]);
  const position = useAsync(
    () => (accountId ? api.getPosition(battle.id, accountId) : Promise.resolve(null)),
    [api, battle.id, accountId, battle.vault_a, battle.vault_b],
  );

  const basis = priceBasis(battle, live.data);
  const bpsA = basis ? performanceBps(toBigInt(battle.initial_price_a) || null, basis.a) : null;
  const bpsB = basis ? performanceBps(toBigInt(battle.initial_price_b) || null, basis.b) : null;
  const vaultsUsdc = basis ? vaultsInUsdc(battle, metaA, metaB, basis) : null;
  const lead = battle.winner ?? leader(bpsA, bpsB);

  const depositOpen = battle.status === "Approved" && now > 0 && msUntilNs(toBigInt(battle.deposit_deadline_ns), now) > 0;
  const pos = position.data;
  const preview = pos && vaultsUsdc ? previewWinnerPayout(pos, vaultsUsdc) : null;

  const timer =
    battle.status === "Approved"
      ? { label: "Deposits close in", ns: toBigInt(battle.deposit_deadline_ns) }
      : battle.status === "Live"
        ? { label: "Battle ends in", ns: toBigInt(battle.end_time_ns) }
        : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg">
          <span className="text-neon-cyan">{metaA.symbol}</span> <span className="text-mute">vs</span>{" "}
          <span className="text-neon-pink">{metaB.symbol}</span>
        </h1>
        <Badge tone={STATUS_TONE[battle.status]}>{STATUS_LABEL[battle.status]}</Badge>
        <span className="font-pixel text-[9px] text-mute">#{battle.id}</span>
      </div>

      <Card>
        <StatusTimeline status={battle.status} />
        <div className="mt-4 flex flex-wrap gap-x-8 gap-y-1 text-xl">
          {timer && (
            <span className="text-neon-amber">
              {timer.label}: <Countdown targetNs={timer.ns} />
            </span>
          )}
          {battle.status === "Proposed" && <span className="text-mute">Waiting for the agent to audit both coins.</span>}
          {battle.status === "Settling" && <span className="text-neon-amber">Final prices locked, executing settlement plan.</span>}
          {battle.status === "EmergencyHalted" && <span className="text-neon-red">Halted. Stakes can be withdrawn in full.</span>}
          {battle.status === "Voided" && <span className="text-neon-red">Voided. Stakes can be withdrawn in full.</span>}
          <span className="text-mute">Creator: {battle.creator}</span>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Tribe side="A" token={battle.token_a} meta={metaA} vault={toBigInt(battle.vault_a)} usdc={vaultsUsdc?.a ?? null} winner={battle.winner === "A"} bps={bpsA} />
        <Tribe side="B" token={battle.token_b} meta={metaB} vault={toBigInt(battle.vault_b)} usdc={vaultsUsdc?.b ?? null} winner={battle.winner === "B"} bps={bpsB} />
      </div>

      <Card>
        <CardTitle>
          {basis?.source === "final" ? "Final performance" : basis?.source === "live" ? "Live performance" : "Performance"}
        </CardTitle>
        {bpsA === null || bpsB === null ? (
          <p className="text-xl text-mute">Prices are recorded when the deposit window closes. The meters start then.</p>
        ) : (
          <div className="space-y-4">
            <HpBar label={metaA.symbol} right={formatBps(bpsA)} percent={perfPercent(bpsA)} tone={lead === "A" ? "green" : "cyan"} />
            <HpBar label={metaB.symbol} right={formatBps(bpsB)} percent={perfPercent(bpsB)} tone={lead === "B" ? "green" : "pink"} />
            <p className="text-lg text-mute">
              {lead ? `Tribe ${lead} leads.` : "Dead even."} Meter: 0% sits in the middle, full is +20%.
            </p>
          </div>
        )}
        {vaultsUsdc && vaultsUsdc.a + vaultsUsdc.b > 0n && (
          <div className="mt-4">
            <HpBar
              label="Vault share (A)"
              right={`${((vaultsUsdc.a * 100n) / (vaultsUsdc.a + vaultsUsdc.b)).toString()}%`}
              percent={Number((vaultsUsdc.a * 100n) / (vaultsUsdc.a + vaultsUsdc.b))}
              tone="amber"
            />
          </div>
        )}
      </Card>

      {accountId && pos && (
        <Card>
          <CardTitle>Your position</CardTitle>
          <p className="text-xl">
            Tribe {pos.side}: {formatUnits(toBigInt(pos.coin_amount), (pos.side === "A" ? metaA : metaB).decimals, 4)}{" "}
            {(pos.side === "A" ? metaA : metaB).symbol} (~{formatUsdc(toBigInt(pos.usdc_equiv))})
          </p>
          {preview && (battle.status === "Settled" ? battle.winner === pos.side : true) && preview.profit > 0n && (
            <p className="mt-1 text-lg text-mute">
              If tribe {pos.side} wins: {formatUsdc(preview.totalLiquid)} liquid, {formatUsdc(preview.credit)} locked credit.
            </p>
          )}
          <Link href="/portfolio" className="mt-2 inline-block font-pixel text-[9px] uppercase text-neon-cyan underline">
            Manage in portfolio
          </Link>
        </Card>
      )}

      {depositOpen && (
        <DepositForm battle={battle} metaA={metaA} metaB={metaB} lockedSide={pos?.side ?? null} onDone={() => { reload(); position.reload(); }} />
      )}

      {depositOpen && <TerminalPanel scopeBattleId={battle.id} onDone={() => { reload(); position.reload(); }} />}

      {plan.data && plan.data.length > 0 && (
        <Card>
          <CardTitle>Settlement plan</CardTitle>
          <ol className="space-y-1 text-xl">
            {plan.data.map((s) => (
              <li key={s.index} className="flex justify-between">
                <span>
                  {s.index + 1}. {s.kind}
                </span>
                <span className={s.done ? "text-neon-green" : "text-mute"}>{s.done ? "done" : "pending"}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}

export default function BattleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const api = useArena();
  const battleId = Number(id);
  const { data, error, loading, reload } = useAsync(
    () => (Number.isInteger(battleId) && battleId >= 0 ? api.getBattle(battleId) : Promise.resolve(null)),
    [api, battleId],
  );

  if (loading && !data) return <p className="blink font-pixel text-[10px] text-mute">LOADING...</p>;
  if (error) return <p role="alert" className="text-2xl text-neon-red">Could not load battle: {error}</p>;
  if (!data) return <p className="text-2xl text-mute">Battle not found. <Link href="/" className="text-neon-cyan underline">Back to the arena</Link></p>;
  return <Detail battle={data} reload={reload} />;
}
