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
import {
  ChevronRight,
} from "lucide-react";

const PAGE = 100;

export default function ArenaPage() {
  const api = useArena();
  const [filter, setFilter] = useState<BattleStatus | "All">("All");

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
  const shown = useMemo(
    () => (data ?? []).filter((b) => filter === "All" || b.status === filter),
    [data, filter],
  );

  return (
    <div className="space-y-8">
      <section id="battle-list" className="scroll-mt-40 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="eyebrow text-neon-green">01 / DISCOVER A BATTLE</p>
            <h2 className="mt-2 text-2xl">
              Battle lobby{" "}
              <span className="ml-2 align-middle font-mono text-xs text-mute">
                {data
                  ? `${data.length.toString().padStart(2, "0")} BATTLES`
                  : "—"}
              </span>
            </h2>
          </div>
          <Link
            href="/portfolio"
            className="flex items-center gap-2 text-xs text-mute hover:text-neon-green"
          >
            Your portfolio <ChevronRight size={14} />
          </Link>
        </div>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Filter by status"
        >
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
              className={cn(
                "rounded-lg border px-4 py-2 font-pixel text-xs transition-colors",
                filter === f.value
                  ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
                  : "border-edge text-mute hover:text-ink",
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
        {loading && !data && (
          <p className="blink font-pixel text-[10px] text-mute">LOADING...</p>
        )}
        {data && shown.length === 0 && (
          <p className="text-2xl text-mute">No battles with this status yet.</p>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((b) => (
            <BattleCard
              key={b.id}
              battle={b}
              participants={[
                { token: metas[b.token_a]!, vault: b.vault_a, winner: b.winner === "A" },
                { token: metas[b.token_b]!, vault: b.vault_b, winner: b.winner === "B" },
              ]}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
