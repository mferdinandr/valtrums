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

const PAGE = 100;

export default function BattleListPage() {
  const api = useArena();
  const [filter, setFilter] = useState<BattleStatus | "All">("All");

  const { data, error, loading, reload } = useAsync(async () => {
    const count = await api.getBattleCount();
    const out = [];
    for (let from = 0; from < count; from += PAGE) out.push(...(await api.getBattles(from, PAGE)));
    return out.sort((a, b) => b.id - a.id);
  }, [api]);

  const metas = useTokenMetas((data ?? []).flatMap((b) => [b.token_a, b.token_b]));
  const shown = useMemo(() => (data ?? []).filter((b) => filter === "All" || b.status === filter), [data, filter]);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="text-xl leading-relaxed text-neon-green drop-shadow-[0_0_8px_rgba(57,255,136,0.6)] sm:text-2xl">
          Pick a tribe.
          <br />
          <span className="text-neon-pink">Take their liquidity.</span>
        </h1>
        <p className="max-w-2xl text-2xl text-mute">
          Two meme coins enter, one vault walks away with both. Back a tribe with the coin itself and share the loser&apos;s pot.
        </p>
        <Button asChild variant="pink">
          <Link href="/battles/new">Start a battle</Link>
        </Button>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
              className={cn(
                "border-2 px-3 py-2 font-pixel text-[9px] uppercase",
                filter === f.value ? "border-neon-cyan bg-neon-cyan/15 text-neon-cyan" : "border-edge text-mute hover:text-ink",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        {error && (
          <Card className="border-neon-red text-neon-red">
            <p>Could not load battles: {error}</p>
            <Button variant="ghost" size="sm" className="mt-3" onClick={reload}>
              Retry
            </Button>
          </Card>
        )}
        {loading && !data && <p className="blink font-pixel text-[10px] text-mute">LOADING...</p>}
        {data && shown.length === 0 && <p className="text-2xl text-mute">No battles with this status yet.</p>}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((b) => (
            <BattleCard key={b.id} battle={b} metaA={metas[b.token_a]!} metaB={metas[b.token_b]!} />
          ))}
        </div>
      </section>
    </div>
  );
}
