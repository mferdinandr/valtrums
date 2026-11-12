"use client";

import { Flame, Timer, Undo2, Vote } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { useWallet } from "@/components/providers";
import { useAction } from "@/hooks/use-action";
import { useDeploymentFacts } from "@/hooks/use-portfolio";
import { useActionRunner } from "@/hooks/use-action-runner";
import { useNow } from "@/hooks/use-now";
import { formatCountdown, formatUnits } from "@/lib/amounts";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import {
  buildBurnReview,
  buildExecuteReview,
  buildReserveEscrowReview,
  buildVoteReview,
  burnRequest,
  canRequestBurn,
  burnSharePercent,
  daoStep,
  executeRequest,
  readBurnFacts,
  readDisposition,
  type BurnFacts,
  reserveEscrowRequest,
  voteMsLeft,
  voteRequest,
  type Disposition,
} from "@/lib/arena-read/dao";
import { readMyPositions } from "@/lib/arena-read/positions";
import type { Namespace } from "@/lib/arena-read/application";
import { config } from "@/lib/config";

const POLL_MS = 5_000;
const clampPercent = (raw: string): number => {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
};

/**
 * What happens to the winning principal: the winners' burn-or-return vote, then the reserve and execute steps.
 * Every number comes from the arena's own disposition view. A burn is shown as a reservation for the sink,
 * never as burned supply. Each button prepares one reviewed call; nothing is signed without the wallet.
 */
export function DaoDecision({
  namespace, arena, battleId, winner, communityCount, backing, nameOf,
}: {
  namespace: Namespace;
  /** The representation (backing) contract of the winning community. */
  backing: string;
  arena: string;
  battleId: number;
  winner: number;
  communityCount: number;
  nameOf: (community: number) => string;
}) {
  const { accountId } = useWallet();
  const { act, connected } = useActionRunner();
  const action = useAction();
  const now = useNow(1000);
  const [view, setView] = useState<Disposition | null>(null);
  const [weight, setWeight] = useState<bigint>(0n);
  const [readError, setReadError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [burnPercent, setBurnPercent] = useState(0);
  // The arena has no view of who voted, so a vote is remembered per account and battle in this browser; a refusal
  // with "Already voted" (another browser, a retry) marks it too. The contract still decides.
  const voteKey = accountId ? `valtrum.dao-vote:${arena}:${battleId}:${accountId}` : null;
  const [voted, setVoted] = useState<number | null>(null);
  useEffect(() => {
    try {
      const saved = voteKey ? window.localStorage.getItem(voteKey) : null;
      setVoted(saved === null ? null : Number(saved));
    } catch {
      setVoted(null);
    }
  }, [voteKey]);
  useEffect(() => {
    if (action.error?.includes("Already voted")) setVoted((previous) => previous ?? -1);
  }, [action.error]);
  const markVoted = useCallback((percent: number) => {
    setVoted(percent);
    try {
      if (voteKey) window.localStorage.setItem(voteKey, String(percent));
    } catch {
      /* the contract still refuses a second vote */
    }
  }, [voteKey]);
  const [burn, setBurn] = useState<BurnFacts | null>(null);
  const facts = useDeploymentFacts(namespace);
  const payout = facts?.capabilities?.companions.payout ?? null;

  const refresh = useCallback(async () => {
    const [d, positions] = await Promise.all([
      readDisposition(config.rpcUrl, arena, battleId),
      accountId ? readMyPositions(config.rpcUrl, arena, battleId, accountId, communityCount) : Promise.resolve([]),
    ]);
    setView(d);
    setBurn(d?.status === "decided" && BigInt(d.burn_total) > 0n && d.escrow_reserved ? await readBurnFacts(config.rpcUrl, arena, battleId, backing, payout).catch(() => null) : null);
    setWeight(BigInt(positions.find((p) => p.community === winner)?.amount ?? "0"));
    setReadError(null);
  }, [arena, battleId, accountId, communityCount, winner, backing, payout]);

  useEffect(() => {
    let live = true;
    const tick = () => refresh().catch((e: unknown) => live && setReadError(e instanceof Error ? e.message : String(e)));
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const token = nameOf(winner);
  const units = (v: string) => `${formatUnits(BigInt(v), TOKEN_DECIMALS, 4)} ${token}`;
  const step = daoStep(view);
  // The arena lets anyone reserve and execute, but only the winners need to: one of them is enough.
  const isWinner = weight > 0n;
  const msLeft = view ? voteMsLeft(view, now) : 0;
  const share = view ? burnSharePercent(view) : null;
  const weightLabel = `${formatUnits(weight, TOKEN_DECIMALS, 4)} ${token}`;

  const send = (request: Record<string, unknown>, review: ReturnType<typeof buildVoteReview>): Promise<boolean> =>
    action.run(async () => {
      const result = await act(request, review.ok ? review : null);
      if (result.txHash) setLastTx(result.txHash);
      await refresh();
    });

  const vote = async (percent: number) => {
    if (await send(voteRequest(battleId, percent), buildVoteReview(arena, battleId, percent, weightLabel))) markVoted(percent);
  };

  const totalMs = view?.window_secs ? Number(view.window_secs) * 1000 : 0;
  const pct = totalMs > 0 ? Math.min(100, Math.max(0, (msLeft / totalMs) * 100)) : 0;
  const tallied = view && (view.status === "voting" || view.status === "decided" || view.status === "undecided_escrowed");
  const pill =
    step.kind === "voting" ? { text: "Voting open", color: "#327f7d" }
    : step.kind === "none" ? { text: "Waiting", color: "#8a8f98" }
    : step.kind === "undecided" ? { text: "No votes", color: "#a8802f" }
    : step.kind === "done" ? { text: "Complete", color: "#327f7d" }
    : { text: "Decided", color: "#5b6fb5" };

  return (
    <Card aria-label="DAO decision" className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl" style={{ background: "#ad527322", color: "#ad5273" }}>
            <Vote size={20} aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-sm font-semibold leading-tight">DAO decision</h3>
            <p className="text-xs text-mute">
              {token} winners burn or keep their principal{view?.window_secs ? ` · ${view.window_secs}s vote` : ""}
            </p>
          </div>
        </div>
        <span className="rounded-full px-3 py-1 text-xs font-semibold" style={{ background: `${pill.color}22`, color: pill.color }}>
          {pill.text}
        </span>
      </div>

      {readError && <p role="alert" className="text-xs text-neon-amber">Could not read the decision state: {readError}</p>}
      {!view && !readError && <p role="status" className="text-xs text-mute">Reading the decision state…</p>}
      {step.kind === "none" && <p className="text-sm text-mute">{step.reason}</p>}

      {step.kind === "voting" && (
        <div className="space-y-1">
          <div className="flex items-end justify-between">
            <span className="flex items-center gap-1 text-xs text-mute"><Timer size={14} aria-hidden="true" /> Closes in</span>
            <span className="text-xl font-bold tabular-nums">{now <= 0 ? "…" : formatCountdown(msLeft)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full" style={{ background: "#e6e2d6" }} role="progressbar" aria-label="Vote time left" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <div className="h-full rounded-full transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%`, background: "#327f7d" }} />
          </div>
        </div>
      )}

      {tallied && view && (
        <div className="space-y-2">
          <div className="flex h-3 overflow-hidden rounded-full" style={{ background: "#e6e2d6" }} aria-label="Burn versus return weight">
            {share !== null && (
              <>
                <div style={{ width: `${share}%`, background: "#ad5273" }} />
                <div style={{ width: `${100 - share}%`, background: "#327f7d" }} />
              </>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl p-3" style={{ background: "#ad527314" }}>
              <p className="flex items-center gap-1 text-xs font-semibold" style={{ color: "#ad5273" }}>
                <Flame size={14} aria-hidden="true" /> Burn{share !== null ? ` · ${share}%` : ""}
              </p>
              <p className="text-sm font-semibold tabular-nums">{units(view.burn_weight)}</p>
              {view.status === "decided" && <p className="text-xs text-mute">burns {units(view.burn_total)}</p>}
            </div>
            <div className="rounded-xl p-3" style={{ background: "#327f7d14" }}>
              <p className="flex items-center gap-1 text-xs font-semibold" style={{ color: "#327f7d" }}>
                <Undo2 size={14} aria-hidden="true" /> Return{share !== null ? ` · ${100 - share}%` : ""}
              </p>
              <p className="text-sm font-semibold tabular-nums">{units(view.return_weight)}</p>
              {view.status === "decided" && <p className="text-xs text-mute">returns {units(view.return_total)}</p>}
            </div>
          </div>
          {share === null && <p className="text-center text-xs text-mute">No votes yet</p>}
        </div>
      )}

      {step.kind === "voting" && (
        <div className="space-y-2">
          {!accountId ? (
            <p className="text-xs text-mute">Connect your wallet to vote.</p>
          ) : weight === 0n ? (
            <p className="text-xs text-mute">Only participants who deposited in {token} can vote.</p>
          ) : (
            <>
              {voted !== null ? (
                <>
                  <p className="text-sm font-semibold" style={{ color: "#327f7d" }}>
                    {voted >= 0 ? `You voted ${voted}% burn.` : "You already voted."} One vote per account, and it is final.
                  </p>
                  <Button type="button" className="w-full" disabled>
                    Voted
                  </Button>
                </>
              ) : (
                <>
              <p className="text-xs text-mute">Your weight: {weightLabel}. One vote, final.</p>
              <div className="space-y-2 rounded-xl p-3" style={{ background: "#f6f1e6" }}>
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="burn-percent" className="text-xs font-semibold">Burn share of your vote</label>
                  <span className="flex items-center gap-1">
                    <input
                      id="burn-percent"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={100}
                      step={1}
                      value={burnPercent}
                      onChange={(e) => setBurnPercent(clampPercent(e.target.value))}
                      className="w-16 rounded-lg border px-2 py-1 text-right text-sm font-semibold tabular-nums"
                      style={{ borderColor: "#d8dfd3", background: "#fffdf6" }}
                    />
                    <span className="text-sm font-semibold">%</span>
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={burnPercent}
                  aria-label="Burn share"
                  onChange={(e) => setBurnPercent(clampPercent(e.target.value))}
                  className="w-full"
                />
                <div className="flex gap-1">
                  {[0, 25, 50, 75, 100].map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setBurnPercent(p)}
                      aria-pressed={burnPercent === p}
                      className="flex-1 rounded-lg py-1 text-xs font-semibold"
                      style={{ background: burnPercent === p ? "#ad5273" : "#e6e2d6", color: burnPercent === p ? "#fffaf0" : "#354358" }}
                    >
                      {p}%
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <p className="flex items-center gap-1" style={{ color: "#ad5273" }}><Flame size={14} aria-hidden="true" /> Burn {burnPercent}%</p>
                  <p className="flex items-center gap-1" style={{ color: "#327f7d" }}><Undo2 size={14} aria-hidden="true" /> Return {100 - burnPercent}% (automatic)</p>
                </div>
              </div>
              <Button type="button" className="w-full" disabled={action.busy || !connected} onClick={() => void vote(burnPercent)}>
                Vote {burnPercent}% burn
              </Button>
                </>
              )}
            </>
          )}
        </div>
      )}

      {step.kind === "undecided" && <p className="text-sm">The window closed with no vote. The winning principal stays escrowed.</p>}

      {step.kind === "reserve_escrow" && !isWinner && (
        <p className="text-sm text-mute">The vote is decided. The winners of {token} finish the release; nothing is needed from you.</p>
      )}

      {step.kind === "reserve_escrow" && isWinner && (
        <div className="space-y-2">
          <p className="text-sm">Reserve the escrow first; anyone can do this.</p>
          <Button type="button" disabled={action.busy || !connected} onClick={() => void send(reserveEscrowRequest(battleId), buildReserveEscrowReview(arena, battleId))}>
            Reserve escrow
          </Button>
        </div>
      )}

      {step.kind === "execute" && view && !isWinner && (
        <p className="text-sm text-mute">{view.released} of {view.total_releases} releases recorded. The winners of {token} finish the release; nothing is needed from you.</p>
      )}

      {step.kind === "execute" && view && isWinner && (
        <div className="space-y-2">
          <div className="h-2 overflow-hidden rounded-full" style={{ background: "#e6e2d6" }} role="progressbar" aria-label="Releases recorded" aria-valuemin={0} aria-valuemax={view.total_releases} aria-valuenow={view.released}>
            <div className="h-full rounded-full" style={{ width: `${(view.released / Math.max(1, view.total_releases)) * 100}%`, background: "#5b6fb5" }} />
          </div>
          <p className="text-xs text-mute">{view.released} of {view.total_releases} releases recorded</p>
          <Button type="button" disabled={action.busy || !connected} onClick={() => void send(executeRequest(battleId), buildExecuteReview(arena, battleId, step.batch, step.remaining))}>
            Execute {step.batch} release{step.batch === 1 ? "" : "s"}
          </Button>
        </div>
      )}

      {step.kind === "done" && view && (
        <p className="text-sm">All {view.total_releases} releases are recorded.</p>
      )}

      {step.kind === "done" && burn && (
        <div className="space-y-2 rounded-xl p-3" style={{ background: "#ad527314" }}>
          <p className="flex items-center gap-1 text-xs font-semibold" style={{ color: "#ad5273" }}>
            <Flame size={14} aria-hidden="true" /> Burn to the sink
          </p>
          {BigInt(burn.confirmed) >= BigInt(burn.amount) ? (
            <p className="text-sm">{units(burn.amount)} sent to the sink and confirmed on Robinhood Chain.</p>
          ) : (
            <>
              <p className="text-sm">
                {units(burn.amount)} is reserved for the sink. It counts as burned only after the transfer on Robinhood Chain is confirmed.
              </p>
              {burn.requestStatus !== null && burn.requestStatus !== "restored" && (
                <p className="text-xs font-semibold" style={{ color: "#a8802f" }}>
                  Requested · {burn.requestStatus.replace(/_/g, " ")}. Nothing more to do; it updates here on its own.
                </p>
              )}
              {burn.requestStatus === "restored" && (
                <p className="text-xs text-mute">The earlier transfer did not happen and was restored. You can request it again.</p>
              )}
              {isWinner && (
                <Button
                  type="button"
                  disabled={action.busy || !connected || !canRequestBurn(burn)}
                  onClick={() => void send(burnRequest(battleId), buildBurnReview(payout, arena, backing, burn))}
                >
                  <Flame size={16} aria-hidden="true" /> {canRequestBurn(burn) ? "Send burn to sink" : "Burn requested"}
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {action.busy && <p role="status" className="text-xs text-mute">Waiting for the preview and your wallet…</p>}
      {action.error && <p role="alert" className="text-xs text-neon-red">{action.error}</p>}
      {lastTx && <p className="break-all text-xs text-mute">Last transaction: {lastTx}</p>}
    </Card>
  );
}
