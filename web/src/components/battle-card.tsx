"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Countdown } from "@/components/countdown";
import { formatUnits, toBigInt } from "@/lib/amounts";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/arena/status";
import type { BattleView, TokenMeta } from "@/lib/arena/types";
import { ArrowUpRight, Clock3 } from "lucide-react";

/** A presentation model that can display any number of participants. */
export interface ArenaParticipant {
  token: TokenMeta;
  vault: string;
  winner?: boolean;
}

export function BattleCard({ battle, participants }: { battle: BattleView; participants: ArenaParticipant[] }) {
  const timer = battle.status === "Approved"
    ? { label: "Deposits close", ns: toBigInt(battle.deposit_deadline_ns) }
    : battle.status === "Live"
      ? { label: "Battle ends", ns: toBigInt(battle.end_time_ns) }
      : null;
  return (
    <Link href={`/battles/${battle.id}`} className="arena-card group block h-full">
      <div className="flex items-center justify-between gap-3">
        <span className="arena-card-id">ARENA / {String(battle.id).padStart(3, "0")}</span>
        <Badge tone={STATUS_TONE[battle.status]}>{STATUS_LABEL[battle.status]}</Badge>
      </div>
      <div className="mt-6 flex items-end justify-between gap-3">
        <div><p className="arena-card-label">COMMUNITY BATTLE</p><h3 className="mt-2 text-xl">Choose your tribe</h3></div>
        <span className="arena-count">{participants.length} TRIBES</span>
      </div>
      <div className="arena-roster mt-5">
        {participants.map(({ token, vault, winner }, index) => (
          <div key={token.id} className="arena-contender">
            <span className={`arena-avatar arena-avatar-${index % 4}`} aria-hidden="true">{token.symbol.slice(0, 1)}</span>
            <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{token.symbol}</span><span className="arena-card-label">{winner ? "WINNING TRIBE" : `TRIBE ${String(index + 1).padStart(2, "0")}`}</span></span>
            <span className="text-right"><span className="block font-mono text-sm">{formatUnits(toBigInt(vault), token.decimals, 0)}</span><span className="arena-card-label">IN VAULT</span></span>
          </div>
        ))}
      </div>
      <div className="mt-5 flex items-center justify-between gap-3 border-t border-edge pt-4">
        <span className="flex items-center gap-2 text-xs text-mute"><Clock3 size={14} />{timer ? <>{timer.label}: <span className="text-neon-amber"><Countdown targetNs={timer.ns} /></span></> : STATUS_LABEL[battle.status]}</span>
        <span className="flex items-center gap-1 text-xs font-semibold text-neon-green">View battle <ArrowUpRight size={15} className="transition-transform group-hover:-translate-y-1 group-hover:translate-x-1" /></span>
      </div>
    </Link>
  );
}
