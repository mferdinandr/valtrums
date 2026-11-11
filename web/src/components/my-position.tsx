"use client";

import { useEffect, useState } from "react";
import { Card, CardTitle } from "@/components/ui/card";
import { useWallet } from "@/components/providers";
import { formatUnits } from "@/lib/amounts";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import { readMyPositions, type MyPosition } from "@/lib/arena-read/positions";
import { config } from "@/lib/config";

const POLL_MS = 5_000;

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) {
      setPositions(null);
      return;
    }
    let live = true;
    const read = () =>
      readMyPositions(config.rpcUrl, arena, battleId, accountId, communityCount)
        .then((p) => live && (setPositions(p), setError(null)))
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [accountId, arena, battleId, communityCount]);

  if (!accountId) return null;
  return (
    <Card aria-label="Your position">
      <CardTitle>Your position</CardTitle>
      {error && <p role="alert" className="text-xs text-neon-amber">Could not read your position: {error}</p>}
      {positions === null ? (
        !error && <p role="status" className="text-xs text-mute">Reading your position…</p>
      ) : positions.length === 0 ? (
        <p className="text-sm text-mute">You have no deposit in this battle yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {positions.map((p) => (
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
