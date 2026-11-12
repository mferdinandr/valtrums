"use client";

import { useEffect, useState } from "react";
import { Card, CardTitle } from "@/components/ui/card";
import { TokenIcon } from "@/components/token-icon";
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
        <ul className="space-y-2">
          {mine && (
            <Row
              name={nameOf(0)}
              amount={formatUnits(BigInt(mine.amount), TOKEN_DECIMALS, 4)}
              chip="In escrow"
              tone="amber"
              hint="Held in escrow while the audit and backing approvals are pending. It becomes your position when both are in."
            />
          )}
          {positions.filter((p) => !(mine && p.community === 0 && p.amount === "0")).map((p) => (
            <Row
              key={p.community}
              name={nameOf(p.community)}
              amount={p.amount === "0" ? null : formatUnits(BigInt(p.amount), TOKEN_DECIMALS, 4)}
              chip={p.amount === "0" ? "Joined" : "Deposited"}
              tone={p.amount === "0" ? "grey" : "green"}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

const TONES = {
  green: { background: "#327f7d22", color: "#327f7d" },
  amber: { background: "#a8802f22", color: "#a8802f" },
  grey: { background: "#e6e2d6", color: "#526777" },
} as const;

function Row({ name, amount, chip, tone, hint }: { name: string; amount: string | null; chip: string; tone: keyof typeof TONES; hint?: string }) {
  return (
    <li className="flex items-center gap-3 rounded-xl p-3" style={{ background: "#fffdf6", border: "1px solid #d8dfd3" }} title={hint}>
      <TokenIcon symbol={name} size={36} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{name}</p>
        <p className="text-xs tabular-nums text-mute">{amount === null ? "No deposit yet" : amount}</p>
      </div>
      <span className="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold" style={TONES[tone]}>{chip}</span>
    </li>
  );
}
