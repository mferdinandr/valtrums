"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { useWallet } from "@/components/providers";
import { useAction } from "@/hooks/use-action";
import { useActionRunner } from "@/hooks/use-action-runner";
import { useNow } from "@/hooks/use-now";
import { formatCountdown, formatUnits } from "@/lib/amounts";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import {
  buildExecuteReview,
  buildReserveEscrowReview,
  buildVoteReview,
  burnSharePercent,
  daoStep,
  executeRequest,
  readDisposition,
  reserveEscrowRequest,
  voteMsLeft,
  voteRequest,
  type Disposition,
} from "@/lib/arena-read/dao";
import { readMyPositions } from "@/lib/arena-read/positions";
import { config } from "@/lib/config";

const POLL_MS = 5_000;

/**
 * What happens to the winning principal: the winners' burn-or-return vote, then the reserve and execute steps.
 * Every number comes from the arena's own disposition view. A burn is shown as a reservation for the sink,
 * never as burned supply. Each button prepares one reviewed call; nothing is signed without the wallet.
 */
export function DaoDecision({
  arena, battleId, winner, communityCount, nameOf,
}: {
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

  const refresh = useCallback(async () => {
    const [d, positions] = await Promise.all([
      readDisposition(config.rpcUrl, arena, battleId),
      accountId ? readMyPositions(config.rpcUrl, arena, battleId, accountId, communityCount) : Promise.resolve([]),
    ]);
    setView(d);
    setWeight(BigInt(positions.find((p) => p.community === winner)?.amount ?? "0"));
    setReadError(null);
  }, [arena, battleId, accountId, communityCount, winner]);

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
  const msLeft = view ? voteMsLeft(view, now) : 0;
  const share = view ? burnSharePercent(view) : null;
  const weightLabel = `${formatUnits(weight, TOKEN_DECIMALS, 4)} ${token}`;

  const send = (request: Record<string, unknown>, review: ReturnType<typeof buildVoteReview>) =>
    action.run(async () => {
      const result = await act(request, review.ok ? review : null);
      if (result.txHash) setLastTx(result.txHash);
      await refresh();
    });

  const vote = (choice: "burn" | "return") => send(voteRequest(battleId, choice), buildVoteReview(arena, battleId, choice, weightLabel));

  return (
    <Card aria-label="DAO decision">
      <CardTitle>DAO decision on the winning principal</CardTitle>
      <p className="text-xs text-mute">
        Winners of {token} vote to burn their principal (sent to a sink on Robinhood) or take it back. Each vote counts by its
        deposit; there is no quorum.
      </p>

      {readError && <p role="alert" className="mt-3 text-xs text-neon-amber">Could not read the decision state: {readError}</p>}
      {!view && !readError && <p role="status" className="mt-3 text-xs text-mute">Reading the decision state…</p>}
      {step.kind === "none" && <p className="mt-3 text-sm">{step.reason}</p>}

      {view && (view.status === "voting" || view.status === "decided" || view.status === "undecided_escrowed") && (
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <dt className="text-mute">Burn weight</dt>
          <dd>{units(view.burn_weight)}</dd>
          <dt className="text-mute">Return weight</dt>
          <dd>{units(view.return_weight)}</dd>
          <dt className="text-mute">Burn share</dt>
          <dd>{share === null ? "no votes yet" : `${share}%`}</dd>
          {view.status === "decided" && (
            <>
              <dt className="text-mute">To be burned</dt>
              <dd>{units(view.burn_total)}</dd>
              <dt className="text-mute">To be returned</dt>
              <dd>{units(view.return_total)}</dd>
            </>
          )}
        </dl>
      )}

      {step.kind === "voting" && (
        <div className="mt-3 space-y-2">
          <p className="text-sm font-semibold">
            {now <= 0 ? "Voting is open." : msLeft > 0 ? `Voting closes in ${formatCountdown(msLeft)}.` : "Voting window is ending."}
          </p>
          {!accountId ? (
            <p className="text-xs text-mute">Connect your wallet to vote.</p>
          ) : weight === 0n ? (
            <p className="text-xs text-mute">Only participants who deposited in {token} can vote.</p>
          ) : (
            <>
              <p className="text-xs text-mute">Your weight: {weightLabel}. One vote, final.</p>
              <div className="flex gap-2">
                <Button type="button" disabled={action.busy || !connected} onClick={() => void vote("burn")}>
                  Vote burn
                </Button>
                <Button type="button" disabled={action.busy || !connected} onClick={() => void vote("return")}>
                  Vote return
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {step.kind === "undecided" && (
        <p className="mt-3 text-sm">The window closed with no vote. The winning principal stays escrowed.</p>
      )}

      {step.kind === "reserve_escrow" && (
        <div className="mt-3 space-y-2">
          <p className="text-sm">The vote is decided. Reserve the escrow first; anyone can do this.</p>
          <Button type="button" disabled={action.busy || !connected} onClick={() => void send(reserveEscrowRequest(battleId), buildReserveEscrowReview(arena, battleId))}>
            Reserve escrow
          </Button>
        </div>
      )}

      {step.kind === "execute" && view && (
        <div className="mt-3 space-y-2">
          <p className="text-sm">
            {view.released} of {view.total_releases} releases recorded. Anyone can execute the next batch of {step.batch}.
          </p>
          <Button type="button" disabled={action.busy || !connected} onClick={() => void send(executeRequest(battleId), buildExecuteReview(arena, battleId, step.batch, step.remaining))}>
            Execute {step.batch} release{step.batch === 1 ? "" : "s"}
          </Button>
        </div>
      )}

      {step.kind === "done" && view && (
        <p className="mt-3 text-sm">
          All {view.total_releases} releases are recorded. A burn is reserved for the sink and is confirmed only after the transfer
          is finalized on Robinhood.
        </p>
      )}

      {action.busy && <p role="status" className="mt-3 text-xs text-mute">Waiting for the preview and your wallet…</p>}
      {action.error && <p role="alert" className="mt-3 text-xs text-neon-red">{action.error}</p>}
      {lastTx && <p className="mt-3 break-all text-xs text-mute">Last transaction: {lastTx}</p>}
    </Card>
  );
}
