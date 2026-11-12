"use client";

import { Trophy } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { useWallet } from "@/components/providers";
import { readMyPositions, type MyPosition } from "@/lib/arena-read/positions";
import { TokenIcon } from "@/components/token-icon";
import { BattleClaim } from "@/components/battle-claim";
import { config } from "@/lib/config";

/**
 * Shown once the contract has recorded a winner: who won and, for a backer of the winner, the prize claim. It states no reward amount: the entitlement is computed and paid by the payout flow, so a
 * number here would be a guess.
 */
export function BattleResult({
  arena,
  battleId,
  winner,
  communityCount,
  backings,
  nameOf,
}: {
  arena: string;
  /** The representation (backing) contract of every community of the battle. */
  backings: readonly string[];
  battleId: number;
  winner: number;
  communityCount: number;
  nameOf: (community: number) => string;
}) {
  const { accountId } = useWallet();
  const [positions, setPositions] = useState<MyPosition[] | null>(null);

  useEffect(() => {
    if (!accountId) {
      setPositions(null);
      return;
    }
    let live = true;
    readMyPositions(config.rpcUrl, arena, battleId, accountId, communityCount)
      .then((p) => live && setPositions(p))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [accountId, arena, battleId, communityCount]);

  const backedWinner = (positions ?? []).some((p) => p.community === winner && p.amount !== "0");

  return (
    <Card
      aria-label="Battle result"
      className="relative overflow-hidden"
      style={{ background: "linear-gradient(135deg, #fff6dc 0%, #fffdf6 55%, #eaf4e6 100%)" }}
    >
      <div className="flex items-center gap-4">
        <span className="relative grid place-items-center">
          <TokenIcon symbol={nameOf(winner)} size={64} />
          <span
            className="absolute -bottom-2 -right-2 grid h-8 w-8 place-items-center rounded-full border-2 border-white shadow"
            style={{ background: "#a8802f", color: "#fffaf0" }}
          >
            <Trophy size={16} aria-hidden="true" />
          </span>
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-widest" style={{ color: "#a8802f" }}>WINNER</p>
          <p className="truncate text-2xl font-bold leading-tight">{nameOf(winner)}</p>
          <p className="text-xs text-mute">Battle #{battleId}</p>
        </div>
      </div>

      {backedWinner && <BattleClaim arena={arena} battleId={battleId} backings={backings} />}
    </Card>
  );
}
