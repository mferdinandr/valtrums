"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { CreditPanel } from "@/components/credit-panel";
import { useArena, useWallet } from "@/components/providers";
import { useAction } from "@/hooks/use-action";
import { useAsync } from "@/hooks/use-async";
import { fallbackMeta, useTokenMetas } from "@/hooks/use-token-metas";
import { formatUnits, formatUsdc, toBigInt } from "@/lib/amounts";
import { previewWinnerPayout, priceBasis, vaultsInUsdc } from "@/lib/arena/payout";
import { isRefundable, STATUS_LABEL, STATUS_TONE } from "@/lib/arena/status";
import type { BattleView, PositionView, TokenMeta } from "@/lib/arena/types";

interface Row {
  battle: BattleView;
  position: PositionView;
}

function PositionRow({
  row,
  accountId,
  metaA,
  metaB,
  onDone,
}: {
  row: Row;
  accountId: string;
  metaA: TokenMeta;
  metaB: TokenMeta;
  onDone: () => void;
}) {
  const api = useArena();
  const action = useAction();
  const { battle, position } = row;
  const meta = position.side === "A" ? metaA : metaB;

  const canClaim = battle.status === "Settled" && battle.winner === position.side && !position.claimed;
  const lost = battle.status === "Settled" && battle.winner !== position.side;
  const canRefund = isRefundable(battle.status) && !position.claimed;

  const basis = priceBasis(battle, null);
  const preview = canClaim && basis ? previewWinnerPayout(position, vaultsInUsdc(battle, metaA, metaB, basis)) : null;

  const act = (fn: () => Promise<void>) => void action.run(fn).then((ok) => ok && onDone());

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={`/battles/${battle.id}`} className="font-pixel text-[11px] text-neon-cyan hover:underline">
          #{battle.id} {metaA.symbol} vs {metaB.symbol}
        </Link>
        <Badge tone={STATUS_TONE[battle.status]}>{STATUS_LABEL[battle.status]}</Badge>
      </div>
      <p className="mt-2 text-xl">
        Tribe {position.side} ({meta.symbol}): {formatUnits(toBigInt(position.coin_amount), meta.decimals, 4)} {meta.symbol}{" "}
        <span className="text-mute">(~{formatUsdc(toBigInt(position.usdc_equiv))})</span>
      </p>

      {preview && (
        <ul className="mt-2 text-lg text-mute">
          <li>Principal back, liquid: {formatUsdc(preview.principal)}</li>
          <li>Profit {formatUsdc(preview.profit)} splits 55 / 35 / 5 / 5:</li>
          <li className="pl-4">liquid {formatUsdc(preview.liquid)}, locked credit {formatUsdc(preview.credit)}</li>
          <li className="pl-4">burned {formatUsdc(preview.burn)}, fee {formatUsdc(preview.fee)}</li>
          <li className="text-neon-green">Total liquid now: {formatUsdc(preview.totalLiquid)}</li>
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {canClaim && (
          <Button disabled={action.busy} onClick={() => act(() => api.claim({ signerId: accountId, battleId: battle.id }))}>
            {action.busy ? "Claiming..." : "Claim"}
          </Button>
        )}
        {canRefund && (
          <Button
            variant="pink"
            disabled={action.busy}
            onClick={() => act(() => api.withdrawInitialDeposit({ signerId: accountId, battleId: battle.id }))}
          >
            {action.busy ? "Refunding..." : "Refund deposit"}
          </Button>
        )}
        {position.claimed && <span className="text-neon-green">{isRefundable(battle.status) ? "Refunded" : "Claimed"}</span>}
        {lost && <span className="text-mute">Tribe lost. Nothing to claim.</span>}
        {!canClaim && !canRefund && !position.claimed && !lost && (
          <span className="text-mute">Waiting for the battle to finish.</span>
        )}
      </div>
      {action.error && <p role="alert" className="mt-2 text-lg text-neon-red">{action.error}</p>}
    </Card>
  );
}

export default function PortfolioPage() {
  const api = useArena();
  const { accountId, loading: walletLoading, signIn } = useWallet();

  const { data, error, loading, reload } = useAsync(async () => {
    if (!accountId) return null;
    const account = await api.getAccount(accountId);
    const count = await api.getBattleCount();
    const battles: BattleView[] = [];
    for (let from = 0; from < count; from += 100) battles.push(...(await api.getBattles(from, 100)));
    const rows = (
      await Promise.all(
        battles.map(async (battle) => {
          const position = await api.getPosition(battle.id, accountId);
          return position ? { battle, position } : null;
        }),
      )
    ).filter((r): r is Row => r !== null);
    return { account, rows: rows.sort((x, y) => y.battle.id - x.battle.id) };
  }, [api, accountId]);

  const metas = useTokenMetas((data?.rows ?? []).flatMap((r) => [r.battle.token_a, r.battle.token_b]));

  if (walletLoading) return <p className="blink font-pixel text-[10px] text-mute">LOADING...</p>;
  if (!accountId) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg text-neon-pink">Portfolio</h1>
        <p className="text-2xl text-mute">Connect a wallet to see your positions and credit.</p>
        <Button variant="cyan" onClick={() => void signIn()}>
          Connect wallet
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-lg text-neon-pink">Portfolio</h1>
      {error && <p role="alert" className="text-xl text-neon-red">Could not load portfolio: {error}</p>}
      {loading && !data && <p className="blink font-pixel text-[10px] text-mute">LOADING...</p>}
      {data && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <CreditPanel account={data.account} />
            <Card>
              <CardTitle>Liquid balance</CardTitle>
              <p className="text-4xl text-neon-green">{formatUsdc(toBigInt(data.account.liquid_balance))}</p>
              <p className="mt-2 text-lg text-mute">Claimed winnings that can be withdrawn at any time.</p>
            </Card>
          </div>

          <section className="space-y-4">
            <h2 className="text-sm text-neon-cyan">Positions</h2>
            {data.rows.length === 0 && (
              <p className="text-2xl text-mute">
                No positions yet. <Link href="/" className="text-neon-cyan underline">Pick a battle</Link>.
              </p>
            )}
            {data.rows.map((row) => (
              <PositionRow
                key={row.battle.id}
                row={row}
                accountId={accountId}
                metaA={metas[row.battle.token_a] ?? fallbackMeta(row.battle.token_a)}
                metaB={metas[row.battle.token_b] ?? fallbackMeta(row.battle.token_b)}
                onDone={reload}
              />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
