"use client";

import Link from "next/link";
import { FlowNotice } from "@/components/flow-notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CreditPanel } from "@/components/credit-panel";
import { LiquidBalances, type LiquidRow } from "@/components/liquid-balances";
import { FundBalance } from "@/components/fund-balance";
import { useArena, useTerminalEnv, useWallet } from "@/components/providers";
import { useAction } from "@/hooks/use-action";
import { useAsync } from "@/hooks/use-async";
import { useState } from "react";
import { fallbackMeta, useTokenMetas } from "@/hooks/use-token-metas";
import { formatUnits, formatUsdc, toBigInt } from "@/lib/amounts";
import { previewClaimForBattle, priceBasis } from "@/lib/arena/payout";
import {
  liquidTokenIds,
  metaFor,
  readLiquidBalances,
  withdrawLiquidChecked,
} from "@/lib/arena/withdraw";
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
  balance,
  busyToken,
  onWithdraw,
  onDone,
}: {
  row: Row;
  accountId: string;
  metaA: TokenMeta;
  metaB: TokenMeta;
  /** Liquid balance of this position's coin. */
  balance: bigint;
  busyToken: string | null;
  onWithdraw: (meta: TokenMeta) => void;
  onDone: () => void;
}) {
  const api = useArena();
  const action = useAction();
  const { battle, position } = row;
  const meta = position.side === "A" ? metaA : metaB;

  const canClaim =
    battle.status === "Settled" &&
    battle.winner === position.side &&
    !position.claimed;
  const lost = battle.status === "Settled" && battle.winner !== position.side;
  const canRefund = isRefundable(battle.status) && !position.claimed;

  const basis = priceBasis(battle, null);
  const plan = useAsync(
    () => (canClaim ? api.getSettlementPlan(battle.id) : Promise.resolve(null)),
    [api, battle.id, canClaim],
  );
  const preview =
    canClaim && basis
      ? previewClaimForBattle(battle, position, metaA, metaB, basis, plan.data)
      : null;
  const coinId = position.side === "A" ? battle.token_a : battle.token_b;

  const act = (fn: () => Promise<void>) =>
    void action.run(fn).then((ok) => ok && onDone());

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href={`/battles/${battle.id}`}
          className="font-pixel text-[11px] text-neon-cyan hover:underline"
        >
          #{battle.id} {metaA.symbol} vs {metaB.symbol}
        </Link>
        <Badge tone={STATUS_TONE[battle.status]}>
          {STATUS_LABEL[battle.status]}
        </Badge>
      </div>
      <p className="mt-2 text-xl">
        Tribe {position.side} ({meta.symbol}):{" "}
        {formatUnits(toBigInt(position.coin_amount), meta.decimals, 4)}{" "}
        {meta.symbol}{" "}
        <span className="text-mute">
          (~{formatUsdc(toBigInt(position.usdc_equiv))})
        </span>
      </p>

      {preview && (
        <ul className="mt-2 text-lg text-mute">
          <li className="text-neon-amber">
            Step 1, Claim: credits your liquid balance and grants locked credit.
          </li>
          <li>
            Principal back:{" "}
            {formatUnits(preview.principalCoin, meta.decimals, 4)} {meta.symbol}
          </li>
          <li>
            Liquid reward (55% pool):{" "}
            {formatUnits(preview.rewardCoin, meta.decimals, 4)} {meta.symbol} (~
            {formatUsdc(preview.rewardUsdc)})
          </li>
          <li className="text-neon-green">
            Liquid after claim:{" "}
            {formatUnits(preview.totalCoin, meta.decimals, 4)} {meta.symbol}
          </li>
          <li>
            New locked credit (35% pool): {formatUsdc(preview.credit)}. Burned{" "}
            {formatUsdc(preview.burn)}, fee {formatUsdc(preview.fee)}.
          </li>
          <li className="text-neon-amber">
            Step 2, Withdraw: sends the coins to your wallet.
          </li>
          {preview.estimated && (
            <li>Estimated from final prices until the sale is reported.</li>
          )}
        </ul>
      )}

      {canRefund && (
        <p className="mt-2 text-lg text-mute">
          Step 1, Refund: credits your full deposit of{" "}
          {formatUnits(toBigInt(position.coin_amount), meta.decimals, 4)}{" "}
          {meta.symbol} to your liquid balance. Step 2, Withdraw: sends it to
          your wallet.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {canClaim && (
          <Button
            disabled={action.busy}
            onClick={() =>
              act(() => api.claim({ signerId: accountId, battleId: battle.id }))
            }
          >
            {action.busy ? "Claiming..." : "Claim"}
          </Button>
        )}
        {canRefund && (
          <Button
            variant="pink"
            disabled={action.busy}
            onClick={() =>
              act(() =>
                api.withdrawInitialDeposit({
                  signerId: accountId,
                  battleId: battle.id,
                }),
              )
            }
          >
            {action.busy ? "Refunding..." : "Refund deposit"}
          </Button>
        )}
        {position.claimed && (
          <span className="text-neon-green">
            {isRefundable(battle.status)
              ? "Refunded to liquid balance"
              : "Claimed to liquid balance"}
          </span>
        )}
        {position.claimed && balance > 0n && (
          <Button
            variant="cyan"
            disabled={busyToken !== null}
            onClick={() => onWithdraw({ ...meta, id: coinId })}
          >
            {busyToken === coinId
              ? "Withdrawing..."
              : `Withdraw ${formatUnits(balance, meta.decimals, 4)} ${meta.symbol}`}
          </Button>
        )}
        {lost && (
          <span className="text-mute">Tribe lost. Nothing to claim.</span>
        )}
        {!canClaim && !canRefund && !position.claimed && !lost && (
          <span className="text-mute">Waiting for the battle to finish.</span>
        )}
      </div>
      {action.error && (
        <p role="alert" className="mt-2 text-lg text-neon-red">
          {action.error}
        </p>
      )}
    </Card>
  );
}

export default function PortfolioPage() {
  const api = useArena();
  const env = useTerminalEnv();
  const { accountId, loading: walletLoading, signIn } = useWallet();

  const { data, error, loading, reload } = useAsync(async () => {
    if (!accountId) return null;
    const account = await api.getAccount(accountId);
    const usdc = (await api.getConfig()).usdc;
    const count = await api.getBattleCount();
    const battles: BattleView[] = [];
    for (let from = 0; from < count; from += 100)
      battles.push(...(await api.getBattles(from, 100)));
    const rows = (
      await Promise.all(
        battles.map(async (battle) => {
          const position = await api.getPosition(battle.id, accountId);
          return position ? { battle, position } : null;
        }),
      )
    ).filter((r): r is Row => r !== null);
    const sorted = rows.sort((x, y) => y.battle.id - x.battle.id);
    const tokenIds = liquidTokenIds(
      usdc,
      sorted.map((r) => r.battle),
    );
    const balances = await readLiquidBalances(api, accountId, tokenIds);
    const walletUsdc = await env.chain.usdcBalance(accountId);
    return { account, usdc, tokenIds, balances, walletUsdc, rows: sorted };
  }, [api, env, accountId]);

  const metas = useTokenMetas(
    (data?.rows ?? []).flatMap((r) => [r.battle.token_a, r.battle.token_b]),
  );
  const withdraw = useAction();
  const [busyToken, setBusyToken] = useState<string | null>(null);

  const onWithdraw = (meta: TokenMeta) => {
    if (!accountId || !data) return;
    const amount = data.balances[meta.id] ?? 0n;
    if (amount <= 0n) return;
    setBusyToken(meta.id);
    void withdraw
      .run(async () => {
        await withdrawLiquidChecked(api, {
          signerId: accountId,
          token: meta.id,
          amount,
        });
      })
      .finally(() => {
        setBusyToken(null);
        reload();
      });
  };

  if (walletLoading)
    return <p className="blink font-pixel text-[10px] text-mute">LOADING...</p>;
  if (!accountId) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg text-neon-pink">Portfolio</h1>
        <p className="text-2xl text-mute">
          Connect a wallet to see your positions and credit.
        </p>
        <Button variant="cyan" onClick={() => void signIn()}>
          Connect wallet
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FlowNotice compact />
      <div><p className="eyebrow text-neon-green">04 / TRACK YOUR OUTCOME</p><h1 className="mt-3 text-3xl">Your portfolio.</h1><p className="mt-2 text-sm text-mute">Follow positions, claim eligible outcomes, then withdraw liquid balances.</p></div>
      {error && (
        <p role="alert" className="text-xl text-neon-red">
          Could not load portfolio: {error}
        </p>
      )}
      {loading && !data && (
        <p className="blink font-pixel text-[10px] text-mute">LOADING...</p>
      )}
      {data && (
        <>
          <div className="portfolio-guide"><span>01 &nbsp; FOLLOW YOUR POSITION</span><span>02 &nbsp; CLAIM OR REFUND</span><span>03 &nbsp; WITHDRAW BALANCE</span></div>
          <div className="grid gap-4 md:grid-cols-2">
            <CreditPanel account={data.account} />
            <LiquidBalances
              rows={data.tokenIds.map<LiquidRow>((id) => ({
                meta: metaFor(id, data.usdc, metas, fallbackMeta),
                balance: data.balances[id] ?? 0n,
              }))}
              usdcId={data.usdc}
              busyToken={busyToken}
              error={withdraw.error}
              onWithdraw={(r) => onWithdraw(r.meta)}
            />
          </div>

          <FundBalance
            walletUsdc={data.walletUsdc}
            balance={data.balances[data.usdc] ?? 0n}
            onFunded={reload}
          />

          <section className="space-y-4">
            <h2 className="text-sm text-neon-cyan">Positions</h2>
            {data.rows.length === 0 && (
              <p className="text-2xl text-mute">
                No positions yet.{" "}
                <Link href="/arena" className="text-neon-cyan underline">
                  Pick a battle
                </Link>
                .
              </p>
            )}
            {data.rows.map((row) => (
              <PositionRow
                key={row.battle.id}
                row={row}
                accountId={accountId}
                metaA={
                  metas[row.battle.token_a] ?? fallbackMeta(row.battle.token_a)
                }
                metaB={
                  metas[row.battle.token_b] ?? fallbackMeta(row.battle.token_b)
                }
                balance={
                  data.balances[
                    row.position.side === "A"
                      ? row.battle.token_a
                      : row.battle.token_b
                  ] ?? 0n
                }
                busyToken={busyToken}
                onWithdraw={onWithdraw}
                onDone={reload}
              />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
