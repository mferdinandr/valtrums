"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, CardTitle } from "@/components/ui/card";
import { useWallet } from "@/components/providers";
import { formatUnits } from "@/lib/amounts";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import { readMyPositions, type MyPosition } from "@/lib/arena-read/positions";
import { config } from "@/lib/config";

/**
 * Shown once the contract has recorded a winner: who won, how the connected account stands, and where prizes
 * are claimed. It states no reward amount: the entitlement is computed and paid by the payout flow, so a
 * number here would be a guess.
 */
export function BattleResult({
  arena,
  battleId,
  winner,
  communityCount,
  nameOf,
}: {
  arena: string;
  battleId: number;
  winner: number;
  communityCount: number;
  nameOf: (community: number) => string;
}) {
  const { accountId } = useWallet();
  const [positions, setPositions] = useState<MyPosition[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) {
      setPositions(null);
      return;
    }
    let live = true;
    readMyPositions(config.rpcUrl, arena, battleId, accountId, communityCount)
      .then((p) => live && (setPositions(p), setError(null)))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [accountId, arena, battleId, communityCount]);

  const deposits = (positions ?? []).filter((p) => p.amount !== "0");
  const backedWinner = deposits.find((p) => p.community === winner);
  const amount = (p: MyPosition) => `${formatUnits(BigInt(p.amount), TOKEN_DECIMALS, 4)} ${nameOf(p.community)}`;

  return (
    <Card aria-label="Battle result">
      <CardTitle>Result</CardTitle>
      <p className="text-base font-semibold">{nameOf(winner)} won this battle.</p>
      <p className="text-xs text-mute">Recorded by the arena contract from the round evidence.</p>

      {accountId && error && (
        <p role="alert" className="mt-3 text-xs text-neon-amber">
          Could not read your position: {error}
        </p>
      )}
      {accountId && !error && positions === null && (
        <p role="status" className="mt-3 text-xs text-mute">
          Checking your position…
        </p>
      )}
      {positions !== null && (
        <p className="mt-3 text-sm">
          {backedWinner
            ? `You backed the winner with ${amount(backedWinner)}. Your share of the losing tokens is worked out when prizes are paid.`
            : deposits.length > 0
              ? `You deposited ${deposits.map(amount).join(", ")}, not in the winning community.`
              : "You had no deposit in this battle."}
        </p>
      )}

      <p className="mt-3 text-sm">
        Prizes are claimed in{" "}
        <Link href="/portfolio" className="underline">
          Portfolio
        </Link>
        . The claim stays disabled until this deployment&apos;s custody check passes; Portfolio lists every reason that is
        still open.
      </p>
    </Card>
  );
}
