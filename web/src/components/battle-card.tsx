"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Countdown } from "@/components/countdown";
import { formatUnits, toBigInt } from "@/lib/amounts";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/arena/status";
import type { BattleView, TokenMeta } from "@/lib/arena/types";

export function BattleCard({ battle, metaA, metaB }: { battle: BattleView; metaA: TokenMeta; metaB: TokenMeta }) {
  const timer =
    battle.status === "Approved"
      ? { label: "Deposits close", ns: toBigInt(battle.deposit_deadline_ns) }
      : battle.status === "Live"
        ? { label: "Ends in", ns: toBigInt(battle.end_time_ns) }
        : null;
  return (
    <Link href={`/battles/${battle.id}`} className="block transition-transform hover:-translate-y-1">
      <Card className="h-full hover:border-neon-pink">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-pixel text-[9px] text-mute">#{battle.id}</span>
          <Badge tone={STATUS_TONE[battle.status]}>{STATUS_LABEL[battle.status]}</Badge>
        </div>
        <div className="flex items-center justify-between gap-2 font-pixel text-xs">
          <span className={battle.winner === "A" ? "text-neon-green" : "text-neon-cyan"}>{metaA.symbol}</span>
          <span className="text-neon-pink">VS</span>
          <span className={battle.winner === "B" ? "text-neon-green" : "text-neon-pink"}>{metaB.symbol}</span>
        </div>
        <div className="mt-3 flex justify-between text-lg text-mute">
          <span>{formatUnits(toBigInt(battle.vault_a), metaA.decimals, 0)}</span>
          <span>{formatUnits(toBigInt(battle.vault_b), metaB.decimals, 0)}</span>
        </div>
        {timer && (
          <div className="mt-3 border-t-2 border-edge pt-2 text-lg text-neon-amber">
            {timer.label}: <Countdown targetNs={timer.ns} />
          </div>
        )}
      </Card>
    </Link>
  );
}
