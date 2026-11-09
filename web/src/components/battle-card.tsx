"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Countdown } from "@/components/countdown";
import { formatUnits, toBigInt } from "@/lib/amounts";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/arena/status";
import type { BattleView, TokenMeta } from "@/lib/arena/types";
import { ArrowUpRight, Hexagon } from "lucide-react";

export function BattleCard({
  battle,
  metaA,
  metaB,
}: {
  battle: BattleView;
  metaA: TokenMeta;
  metaB: TokenMeta;
}) {
  const timer =
    battle.status === "Approved"
      ? { label: "Deposits close", ns: toBigInt(battle.deposit_deadline_ns) }
      : battle.status === "Live"
        ? { label: "Ends in", ns: toBigInt(battle.end_time_ns) }
        : null;
  return (
    <Link href={`/battles/${battle.id}`} className="group block">
      <Card className="kinetic-card h-full">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-pixel text-[9px] text-mute">#{battle.id}</span>
          <Badge tone={STATUS_TONE[battle.status]}>
            {STATUS_LABEL[battle.status]}
          </Badge>
        </div>
        <div
          className="relative my-5 flex h-24 items-center justify-around rounded-lg bg-void/60"
          aria-hidden="true"
        >
          <span className="absolute inset-x-8 bottom-3 h-8 rounded-[50%] border border-neon-green/10 bg-neon-green/5" />
          <div className="relative grid h-14 w-14 place-items-center rounded-2xl border border-neon-green/40 bg-gradient-to-br from-neon-green/20 to-neon-green/5 text-neon-green shadow-[5px_6px_0_#0c120a] transition-transform duration-500 group-hover:-translate-y-2 group-hover:rotate-12">
            <Hexagon size={36} strokeWidth={1} />
            <span className="absolute font-pixel text-xs font-bold">
              {metaA.symbol.slice(0, 1)}
            </span>
          </div>
          <span className="font-pixel text-[10px] italic text-mute">VS</span>
          <div className="relative grid h-14 w-14 place-items-center rounded-2xl border border-neon-pink/40 bg-gradient-to-br from-neon-pink/20 to-neon-pink/5 text-neon-pink shadow-[5px_6px_0_#170e20] transition-transform duration-500 group-hover:-translate-y-2 group-hover:-rotate-12">
            <Hexagon size={36} strokeWidth={1} />
            <span className="absolute font-pixel text-xs font-bold">
              {metaB.symbol.slice(0, 1)}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 font-pixel text-base">
          <span
            className={
              battle.winner === "A" ? "text-neon-green" : "text-neon-cyan"
            }
          >
            {metaA.symbol}
          </span>
          <ArrowUpRight
            size={15}
            className="text-mute transition-transform group-hover:-translate-y-1 group-hover:translate-x-1"
          />
          <span
            className={
              battle.winner === "B" ? "text-neon-green" : "text-neon-pink"
            }
          >
            {metaB.symbol}
          </span>
        </div>
        <div className="mt-3 flex justify-between text-lg text-mute">
          <span>
            {formatUnits(toBigInt(battle.vault_a), metaA.decimals, 0)}
          </span>
          <span>
            {formatUnits(toBigInt(battle.vault_b), metaB.decimals, 0)}
          </span>
        </div>
        {timer && (
          <div className="mt-4 border-t border-edge pt-3 text-xs text-neon-amber">
            {timer.label}: <Countdown targetNs={timer.ns} />
          </div>
        )}
      </Card>
    </Link>
  );
}
