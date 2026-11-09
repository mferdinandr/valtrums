"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Countdown } from "@/components/countdown";
import { useNow } from "@/hooks/use-now";
import { msUntilNs, toBigInt } from "@/lib/amounts";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/arena/status";
import type { BattleView, TokenMeta } from "@/lib/arena/types";
import { ArrowUpRight, Clock3 } from "lucide-react";

export interface ArenaParticipant {
  token: TokenMeta;
  vault: string;
  winner?: boolean;
}

function TokenAvatar({ token, index }: { token: TokenMeta; index: number }) {
  const [failed, setFailed] = useState(false);
  const icon = token.icon;
  const safeIcon = icon && (/^https?:\/\//i.test(icon) || /^data:image\/(png|jpeg|webp);base64,/i.test(icon));
  return <span className={`battle-token-avatar arena-avatar-${index % 4}`} title={token.symbol}>
    {safeIcon && !failed ? <img src={icon} alt="" onError={() => setFailed(true)} /> : <span aria-hidden="true">{token.symbol.slice(0, 2).toUpperCase()}</span>}
  </span>;
}

export function BattleCard({ battle, participants }: { battle: BattleView; participants: ArenaParticipant[] }) {
  const now = useNow(1000);
  const depositOpen = battle.status === "Approved" && now > 0 && msUntilNs(toBigInt(battle.deposit_deadline_ns), now) > 0;
  const timer = battle.status === "Approved"
    ? { label: "Deposits close", ns: toBigInt(battle.deposit_deadline_ns) }
    : battle.status === "Live" ? { label: "Battle ends", ns: toBigInt(battle.end_time_ns) } : null;
  const names = participants.map(({ token }) => token.symbol).join(" vs ");
  return (
    <Link href={`/battles/${battle.id}`} className="battle-list-card group block h-full" aria-label={`${names}, battle ${battle.id}, ${STATUS_LABEL[battle.status]}. ${depositOpen ? "Join battle" : "View battle"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone={STATUS_TONE[battle.status]}>{STATUS_LABEL[battle.status]}</Badge>
        <span className="battle-card-id">#{String(battle.id).padStart(3, "0")}</span>
      </div>
      <h3 className="mt-4 text-xl leading-tight">Price performance challenge</h3>
      <p className="mt-2 text-xs leading-5 text-mute">{participants.map(({ token }) => token.symbol).join(" · ")}</p>
      <div className="battle-list-bottom">
        <div className="min-w-0"><div className="flex items-center"><div className="battle-token-stack" aria-hidden="true">{participants.map(({ token }, index) => <TokenAvatar key={token.id} token={token} index={index} />)}</div><span className="ml-3 text-xs text-mute">{participants.length} communities</span></div>
          <p className="mt-3 flex items-center gap-1.5 text-xs text-mute"><Clock3 size={13} />{timer ? <>{timer.label}: <span className="text-neon-amber"><Countdown targetNs={timer.ns} /></span></> : STATUS_LABEL[battle.status]}</p></div>
        <span className={`battle-list-action ${depositOpen ? "battle-list-action-join" : ""}`}>{depositOpen ? "Join" : "View"} <ArrowUpRight size={14} /></span>
      </div>
    </Link>
  );
}

const PREVIEW_TOKENS = ["CASHCAT", "BTCETHUSDT", "REBATE", "OAK", "WIF"].map((symbol) => ({ id: `preview:${symbol}`, symbol, decimals: 0 }));

export function MultiCommunityPreview() {
  return <article className="battle-list-card h-full" aria-label="Illustrative five-community price gain battle preview">
    <div className="flex items-center justify-between gap-2"><Badge tone="amber">Preview</Badge><span className="battle-card-id"># —</span></div>
    <h3 className="mt-4 text-xl leading-tight">Price gain challenge</h3>
    <p className="mt-2 text-xs leading-5 text-mute">{PREVIEW_TOKENS.map((token) => token.symbol).join(" · ")}</p>
    <div className="battle-list-bottom"><div><div className="flex items-center"><div className="battle-token-stack" aria-hidden="true">{PREVIEW_TOKENS.map((token, index) => <TokenAvatar key={token.id} token={token} index={index} />)}</div><span className="ml-3 text-xs text-mute">5 communities</span></div><p className="mt-3 text-xs text-mute">Illustration · not a live battle</p></div><span className="battle-list-action text-mute">Preview</span></div>
  </article>;
}
