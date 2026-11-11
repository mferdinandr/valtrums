"use client";

import { useEffect, useState } from "react";
import { Card, CardTitle } from "@/components/ui/card";
import { useWallet } from "@/components/providers";
import { formatUnits } from "@/lib/amounts";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import { readCreatorEscrow, readMyPositions, type CreatorEscrow, type MyPosition } from "@/lib/arena-read/positions";
import { config } from "@/lib/config";

const POLL_MS = 15_000;

/** What the connected account has in this battle, as the arena reports it. Refreshes on a timer. */
export function MyPosition({
  arena, battleId, communityCount, nameOf,
}: {
  arena: string;
  battleId: number;
  communityCount: number;
  nameOf: (community: number) => string;
}) {
  const { accountId } = useWallet();
  const [positions, setPositions] = useState<MyPosition[] | null>(null);
  const [escrow, setEscrow] = useState<CreatorEscrow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) {
      setPositions(null);
      return;
    }
    let live = true;
    const read = () =>
      Promise.all([
        readMyPositions(config.rpcUrl, arena, battleId, accountId, communityCount),
        readCreatorEscrow(config.rpcUrl, arena, battleId),
      ])
        .then(([p, e]) => live && (setPositions(p), setEscrow(e), setError(null)))
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [accountId, arena, battleId, communityCount]);

  if (!accountId) return null;
  // Only the creator's own escrow is shown as theirs.
  const mine = escrow && escrow.creator === accountId ? escrow : null;
  return (
    <Card aria-label="Your position">
      <CardTitle>Your position</CardTitle>
      {error && <p role="alert" className="text-xs text-neon-amber">Could not read your position: {error}</p>}
      {positions === null ? (
        !error && <p role="status" className="text-xs text-mute">Reading your position…</p>
      ) : positions.length === 0 && !mine ? (
        <p className="text-sm text-mute">You have no deposit in this battle yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {mine && (
            <li>
              <strong>{nameOf(0)}</strong>: {formatUnits(BigInt(mine.amount), TOKEN_DECIMALS, 4)} held in escrow, waiting for
              the audit and backing approvals. It becomes your position when both are in.
            </li>
          )}
          {positions.filter((p) => !(mine && p.community === 0 && p.amount === "0")).map((p) => (
            <li key={p.community}>
              <strong>{nameOf(p.community)}</strong>:{" "}
              {p.amount === "0"
                ? "joined, no deposit yet"
                : `${formatUnits(BigInt(p.amount), TOKEN_DECIMALS, 4)} deposited`}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
