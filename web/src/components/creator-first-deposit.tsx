"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Step } from "@/components/lifecycle-participate";
import { applicationKey, type Namespace } from "@/lib/arena-read/application";
import { readCommunityIndex, readCreatedBattleId } from "@/lib/arena-read/create-deposit";
import { buildDepositReview, depositRequest } from "@/lib/arena-read/deposit-flow";
import { buildJoinReview, joinRequest } from "@/lib/arena-read/open-arena";
import { formatUnits } from "@/lib/amounts";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import { config } from "@/lib/config";

type Phase =
  | { kind: "reading" }
  | { kind: "unreadable"; message: string }
  | { kind: "ready"; battleId: number };

/**
 * The creator's first deposit, shown once the create transaction is confirmed. The battle id comes from the
 * transaction's own event, then two reviewed steps follow: join with the chosen token, then deposit it. The
 * battle exists before this runs, so nothing here is atomic with creation: until the deposit is credited the
 * battle has no creator deposit and the page says so.
 */
export function CreatorFirstDeposit({
  namespace, creator, txHash, representation, label, amount,
}: {
  namespace: Namespace;
  creator: string;
  txHash: string;
  representation: string;
  label: string;
  amount: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "reading" });
  const [community, setCommunity] = useState<number | null>(null);
  const [joinBusy, setJoinBusy] = useState(false);
  const [depositBusy, setDepositBusy] = useState(false);
  const [communityError, setCommunityError] = useState<string | null>(null);

  const load = useCallback(() => {
    setPhase({ kind: "reading" });
    readCreatedBattleId(config.rpcUrl, txHash, creator)
      .then((id) => setPhase(id === null ? { kind: "unreadable", message: "The transaction has no battle-created event yet." } : { kind: "ready", battleId: id }))
      .catch((e: unknown) => setPhase({ kind: "unreadable", message: e instanceof Error ? e.message : String(e) }));
  }, [txHash, creator]);
  useEffect(load, [load]);

  const battleId = phase.kind === "ready" ? phase.battleId : 0;
  const joinReview = useMemo(
    () => buildJoinReview(namespace.arenaContract, battleId, representation, label),
    [namespace.arenaContract, battleId, representation, label],
  );
  const joinReq = useMemo(() => joinRequest(battleId, representation), [battleId, representation]);
  const depositReview = useMemo(
    () => buildDepositReview({ arena: namespace.arenaContract, representation, battleId, community: community ?? 0, amount }),
    [namespace.arenaContract, representation, battleId, community, amount],
  );
  const depositReq = useMemo(() => depositRequest(battleId, community ?? 0, amount), [battleId, community, amount]);

  // The community index is whatever the arena reports after the join, never assumed to be 0.
  const readIndex = useCallback(async () => {
    setCommunityError(null);
    try {
      const index = await readCommunityIndex(config.rpcUrl, namespace.arenaContract, battleId, representation);
      if (index === null) setCommunityError("The arena does not list your community yet. Try again in a moment.");
      setCommunity(index);
    } catch (e) {
      setCommunityError(e instanceof Error ? e.message : String(e));
    }
  }, [namespace.arenaContract, battleId, representation]);

  return (
    <Card aria-label="Your first deposit">
      <CardTitle>Now deposit your {label}</CardTitle>
      <p className="mb-3 text-xs text-mute">
        Your battle is created, but it has no deposit from you yet. Join with {label}, then deposit. Until your deposit
        is credited, the battle cannot lock.
      </p>
      {phase.kind === "reading" && <p role="status" className="text-xs text-mute">Reading your new battle…</p>}
      {phase.kind === "unreadable" && (
        <div role="alert" className="space-y-2 text-xs text-neon-amber">
          <p>Could not read the new battle id. {phase.message}</p>
          <Button type="button" variant="ghost" onClick={load}>Try again</Button>
        </div>
      )}
      {phase.kind === "ready" && (
        <div className="space-y-8">
          <p className="text-xs text-mute">
            Battle <Link href={`/arena/${battleId}`} className="text-neon-green">#{battleId}</Link>
          </p>
          <Step
            namespaceKey={applicationKey(namespace)}
            onSigningChange={setJoinBusy}
            busyElsewhere={depositBusy}
            title={`Join with ${label} (a small storage fee, not a stake)`}
            review={joinReview}
            request={joinReq}
            onDone={() => void readIndex()}
          />
          {community === null ? (
            <div className="space-y-2 text-xs text-mute">
              <p>The deposit unlocks after the join is confirmed and your community is listed.</p>
              {communityError && <p role="alert" className="text-neon-amber">{communityError}</p>}
              <Button type="button" variant="ghost" onClick={() => void readIndex()} disabled={joinBusy}>
                Check that I joined
              </Button>
            </div>
          ) : (
            <Step
              namespaceKey={applicationKey(namespace)}
              onSigningChange={setDepositBusy}
              busyElsewhere={joinBusy}
              title={`Deposit ${formatUnits(BigInt(amount), TOKEN_DECIMALS, 4)} ${label}`}
              review={depositReview}
              request={depositReq}
            />
          )}
        </div>
      )}
    </Card>
  );
}
