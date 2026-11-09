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
import { KineticScene } from "@/components/kinetic/scene";
import {
  ArrowUpRight,
  Plus,
  Swords,
  ShieldCheck,
  Coins,
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
      <div className="flex items-center justify-between">
        <p className="eyebrow">01 / Browse available battles</p>
        <span className="eyebrow hidden sm:block">01 — Arena lobby</span>
      </div>
      <section className="machine-hero grid lg:grid-cols-[.95fr_1.05fr]">
        <div className="relative z-10 px-6 pt-9 sm:px-9 lg:py-14 lg:pl-12">
          <span className="inline-flex items-center gap-2 rounded-full border border-neon-green/25 bg-neon-green/5 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[.14em] text-neon-green">
            <span className="status-dot" /> Current arena / two communities
          </span>
          <h1 className="mt-6 text-[clamp(2.8rem,5.7vw,5.5rem)] font-medium leading-[.98] tracking-[-.065em]">
            Pick your tribe.
            <br />
            <span className="text-neon-green">Enter the arena.</span>
          </h1>
          <p className="mt-5 max-w-sm text-sm leading-7 text-mute">
            Browse current battles, inspect the status and vaults, then choose a community while deposits are open.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <a href="#battle-list">
                Explore battles <ArrowUpRight size={16} />
              </a>
            </Button>
            <Button asChild variant="ghost" size="lg">
              <Link href="/battles/new">
                <Plus size={15} /> Create battle
              </Link>
            </Button>
          </div>
          <div className="mt-8 flex gap-5 border-t border-edge/70 py-5 text-[10px] text-mute">
            <span className="flex items-center gap-2">
              <Swords size={13} /> Community battles
            </span>
            <span className="flex items-center gap-2">
              <Coins size={13} /> Token-backed vaults
            </span>
          </div>
        </div>
        <div className="relative min-w-0">
          <div className="absolute right-6 top-6 z-10 hidden font-mono text-[9px] uppercase leading-5 tracking-widest text-mute/70 lg:block">
            Kinetic arena
            <br />
            Many tribes / One arena
          </div>
          <KineticScene className="h-[310px] sm:h-[400px] lg:h-full lg:min-h-[480px]" />

        </div>
      </section>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          {
            icon: Swords,
            title: "Choose your side",
            text: "Find a battle and back a community.",
          },
          {
            icon: ShieldCheck,
            title: "Know the mechanics",
            text: "Inspect vaults, status and settlement details.",
          },
          {
            icon: Coins,
            title: "Manage your outcome",
            text: "Claim and withdraw from your portfolio.",
          },
        ].map((item, i) => (
          <div
            key={item.title}
            className="flex items-start gap-3 rounded-xl border border-edge/70 px-5 py-4"
          >
            <span className="rounded-lg bg-neon-green/5 p-2.5 text-neon-green">
              <item.icon size={18} strokeWidth={1.5} />
            </span>
            <div>
              <p className="font-pixel text-xs">{item.title}</p>
              <p className="mt-1 text-[11px] leading-5 text-mute">
                {item.text}
              </p>
            </div>
            <span className="ml-auto font-mono text-[10px] text-mute/50">
              0{i + 1}
            </span>
          </div>
        ))}
      </div>
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
