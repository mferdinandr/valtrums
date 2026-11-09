"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { BattleCard } from "@/components/battle-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useArena } from "@/components/providers";
import { useAsync } from "@/hooks/use-async";
import { useTokenMetas } from "@/hooks/use-token-metas";
import { STATUS_FILTERS } from "@/lib/arena/status";
import type { BattleStatus } from "@/lib/arena/types";
import { cn } from "@/lib/utils";
import { ChevronRight, Plus, Search, Landmark } from "lucide-react";

const PAGE = 100;

export default function ArenaPage() {
  const api = useArena();
  const [filter, setFilter] = useState<BattleStatus | "All">("All");
  const [view, setView] = useState<"battles" | "dao">("battles");
  const [query, setQuery] = useState("");

  const { data, error, loading, reload } = useAsync(async () => {
    const count = await api.getBattleCount();
    const out = [];
    for (let from = 0; from < count; from += PAGE)
      out.push(...(await api.getBattles(from, PAGE)));
    return out.sort((a, b) => b.id - a.id);
  }, [api]);

  const metas = useTokenMetas(
    (data ?? []).flatMap((b) => [b.token_a, b.token_b]),
  );
  const entries = useMemo(() => (data ?? []).map((battle) => ({
    battle,
    participants: [
      { token: metas[battle.token_a]!, vault: battle.vault_a, winner: battle.winner === "A" },
      { token: metas[battle.token_b]!, vault: battle.vault_b, winner: battle.winner === "B" },
    ],
  })), [data, metas]);
  const term = query.trim().toLowerCase();
  const shown = entries.filter(({ battle, participants }) =>
    (filter === "All" || battle.status === filter) &&
    (!term || String(battle.id).includes(term) || participants.some(({ token }) =>
      token.symbol.toLowerCase().includes(term) || token.id.toLowerCase().includes(term)))
  );

  return (
    <div className="space-y-8">
      <section id="battle-list" className="scroll-mt-40 space-y-5">
        <div className="arena-list-header">
          <div><p className="eyebrow text-neon-green">COMMUNITY BATTLEGROUND</p><h1 className="mt-3 text-3xl md:text-4xl">Explore the arena.</h1><p className="mt-3 max-w-xl text-sm leading-6 text-mute">Find a community battle, inspect its vaults and follow its progress.</p></div>
          <Link href="/battles/new" className="arena-create"><Plus size={16} /> Create battle</Link>
        </div>
        <div className="arena-view-tabs" role="group" aria-label="Arena view">
          <button type="button" aria-pressed={view === "battles"} onClick={() => setView("battles")} className={cn("arena-view-tab", view === "battles" && "arena-view-tab-active")}>Battles <span>{data?.length ?? "—"}</span></button>
          <button type="button" aria-pressed={view === "dao"} onClick={() => setView("dao")} className={cn("arena-view-tab", view === "dao" && "arena-view-tab-active")}><Landmark size={15} /> DAO <span>Planned</span></button>
        </div>
        {view === "dao" ? (
          <div className="arena-dao-empty"><Landmark size={24} className="text-neon-green" /><h2 className="mt-4 text-xl">DAO decisions are not available yet.</h2><p className="mt-2 max-w-lg text-sm leading-6 text-mute">The planned flow places winning principal in DAO escrow for a burn or return decision. Governance rules and DAO status data are still being developed.</p><button type="button" onClick={() => setView("battles")} className="mt-4 text-sm text-neon-green underline">Browse battles</button></div>
        ) : (<>
        <div className="arena-filter-bar">
          <label className="arena-search"><Search size={16} aria-hidden="true" /><span className="sr-only">Search by community or battle ID</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search community or battle ID" /></label>
          <Link href="/portfolio" className="flex items-center gap-2 text-xs text-mute hover:text-neon-green">Your portfolio <ChevronRight size={14} /></Link>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by battle status">
          {STATUS_FILTERS.map((f) => <button key={f.value} onClick={() => setFilter(f.value)} aria-pressed={filter === f.value} className={cn("rounded-lg border px-4 py-2 font-pixel text-xs transition-colors", filter === f.value ? "border-neon-green/40 bg-neon-green/10 text-neon-green" : "border-edge text-mute hover:text-ink")}>{f.label}</button>)}
        </div>
        <p className="text-xs text-mute">{data ? `${shown.length} ${shown.length === 1 ? "battle" : "battles"} shown` : "Loading battles…"} · Current data contains two communities per battle.</p>
        {error && (
          <Card className="border-neon-red text-neon-red">
            <p>Could not load battles: {error}</p>
            <Button variant="ghost" size="sm" className="mt-3" onClick={reload}>
              Retry
            </Button>
          </Card>
        )}
        {loading && !data && (
          <p className="blink font-pixel text-[10px] text-mute">LOADING...</p>
        )}
        {data && shown.length === 0 && (
          <p className="text-2xl text-mute">No battles match these filters.</p>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map(({ battle, participants }) => (
            <BattleCard key={battle.id} battle={battle} participants={participants} />
          ))}
        </div>
        </>)}
      </section>
    </div>
  );
}
