"use client";

import { useEffect, useState } from "react";
import {
  BadgeCheck,
  Coins,
  ExternalLink,
  Flag,
  Gavel,
  HandCoins,
  LineChart,
  Lock,
  ShieldCheck,
  Trophy,
  UserPlus,
  Vote,
  type LucideIcon,
} from "lucide-react";
import { config } from "@/lib/config";
import { loadBattleActivity, makePost, makeRpc, type ActivityKind, type BattleActivity } from "@/lib/onchain-proof";

const INDEXER = config.network === "mainnet" ? "https://tx.main.fastnear.com" : "https://tx.test.fastnear.com";

const ICONS: Record<ActivityKind, LucideIcon> = {
  create: Flag,
  join: UserPlus,
  deposit: Coins,
  audit: ShieldCheck,
  backing: ShieldCheck,
  lock: Lock,
  round: Flag,
  prices: LineChart,
  settle: Trophy,
  escrow: Lock,
  vote: Vote,
  execute: Gavel,
  claim: HandCoins,
  other: BadgeCheck,
};

/** Results are reused for a while so reloads do not hit the public RPC and indexer again. */
const CACHE_MS = 10 * 60 * 1000;

/** Supporting checks shown only with "Show all". */
const DETAIL: ActivityKind[] = ["audit", "backing", "other"];

const time = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Every on-chain step of the battle, each linked to its transaction on the explorer. */
export function OnchainProof({ contract, battleId }: { contract: string; battleId: number }) {
  const [data, setData] = useState<BattleActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let live = true;
    const key = `valtrums:activity:${contract}:${battleId}`;
    try {
      const cached = JSON.parse(window.localStorage.getItem(key) ?? "null") as { at: number; data: BattleActivity } | null;
      if (cached && Date.now() - cached.at < CACHE_MS) {
        setData(cached.data);
        return;
      }
    } catch {
      // Storage blocked or corrupt: load from the chain.
    }
    loadBattleActivity({ rpc: makeRpc(config.rpcUrl), post: makePost(), indexer: INDEXER, contract, battleId })
      .then((a) => {
        if (!live) return;
        setData(a);
        try {
          window.localStorage.setItem(key, JSON.stringify({ at: Date.now(), data: a }));
        } catch {
          // Caching is optional.
        }
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [contract, battleId]);

  return (
    <section aria-label="On-chain activity" className="pixel-frame">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BadgeCheck size={22} className="text-neon-green" aria-hidden />
          <h2 className="text-lg">On-chain activity</h2>
          <span className="rounded-full border border-edge px-2 py-0.5 text-xs text-mute">NEAR {config.network}</span>
        </div>
        {data?.winner && (
          <span className="inline-flex items-center gap-2 rounded-full border border-neon-green bg-neon-green/10 px-3 py-1 font-pixel text-sm font-semibold">
            <Trophy size={16} className="text-neon-amber" aria-hidden /> {data.winner} won
          </span>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm text-neon-red">
          Could not load the transactions: {error}
        </p>
      )}
      {!data && !error && <p className="mt-4 text-sm text-mute">Finding this battle’s transactions…</p>}
      {data && data.items.length === 0 && <p className="mt-4 text-sm text-mute">No transactions found for this battle yet.</p>}

      {data && data.items.length > 0 && (
        <ol className="mt-4 space-y-2">
          {data.items.filter((i) => all || !DETAIL.includes(i.kind) && !(i.kind === "join" && i.label.startsWith("Backer"))).map((item) => {
            const Icon = ICONS[item.kind];
            const highlight = item.kind === "settle" || item.kind === "create";
            return (
              <li
                key={item.hash}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border px-4 py-2.5 ${highlight ? "border-neon-green bg-neon-green/10" : "border-edge bg-panel"}`}
              >
                <Icon size={16} className="shrink-0 text-neon-green" aria-hidden />
                <span className="min-w-0 flex-1 text-sm font-semibold text-ink">{item.label}</span>
                <span className="text-xs text-mute">{time(item.timeMs)}</span>
                <a
                  href={`${config.explorerUrl}/txns/${encodeURIComponent(item.hash)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={item.hash}
                  aria-label={`View transaction ${item.hash} on the explorer`}
                  className="inline-flex min-h-11 items-center gap-1 font-mono text-xs underline underline-offset-4 hover:text-ink"
                >
                  {item.hash.slice(0, 6)}…{item.hash.slice(-4)} <ExternalLink size={12} aria-hidden />
                </a>
              </li>
            );
          })}
        </ol>
      )}
      {data && data.items.length > 0 && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="mt-3 inline-flex min-h-11 items-center rounded-full border border-edge bg-panel px-4 text-xs text-mute hover:text-ink"
        >
          {all ? "Show key steps only" : `Show all ${data.items.length} transactions (incl. safety checks)`}
        </button>
      )}
    </section>
  );
}
