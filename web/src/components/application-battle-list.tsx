"use client";

import { useState } from "react";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { Plus, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useApplicationSearch } from "@/hooks/use-application-search";
import type {
  Namespace,
  ApplicationBattlePage,
} from "@/lib/arena-read/application";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { ObservationChart } from "@/components/battle-chart/observation-chart";
import { CarnivalScene } from "@/components/carnival/scene";
import { TokenIcon } from "@/components/token-icon";
import { displaySymbol } from "@/lib/arena-read/token-style";
import { utc } from "@/lib/arena-read/open-arena";
import {
  communityName,
  modeName,
  shortAccount,
} from "@/lib/arena-read/lifecycle-presentation";
import "@/components/lifecycle/lifecycle.css";

/** Lifecycle reads retain their own DTO; never reinterpret them as legacy A/B economics. */
export function ApplicationBattleList({ namespace }: { namespace: Namespace }) {
  const [chartFor, setChartFor] = useState<string | null>(null);
  const [q, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const { result, loading, error } =
    useApplicationSearch<ApplicationBattlePage>(namespace, "battles", {
      q,
      status,
      cursor,
    });
  return (
    <section className="lifecycle-page" aria-label="Application battles">
      <header className="arcade-heading arcade-heading--arena">
        <div>
          <span className="arcade-kicker">THE MATCH BOARD</span>
          <h1>Pick your battle.</h1>
          <p>Find a crew to cheer for, or start a rivalry of your own.</p>
          <div className="lifecycle-actions">
            <Button asChild>
              <Link href="/arena/new">
                <Plus size={16} /> Create a battle
              </Link>
            </Button>
          </div>
        </div>
        <CarnivalScene
          mode="arena"
          caption="Your fairground hosts"
        />
      </header>
      <div className="lifecycle-heading">
        <h2>Battle line-up</h2>
      </div>
      <label className="arena-search">
        <Search size={16} aria-hidden="true" />
        <span className="sr-only">Search community or battle ID</span>
        <input
          value={q}
          maxLength={64}
          placeholder="Search community or battle ID"
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(undefined);
          }}
        />
      </label>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Filter by battle status"
      >
        {["", "open", "locked", "decided", "cancelled"].map((value) => (
          <button
            key={value}
            aria-pressed={status === value}
            className={cn(
              "rounded-lg border px-4 py-2 text-xs",
              status === value
                ? "border-neon-green text-neon-green"
                : "border-edge text-mute",
            )}
            onClick={() => {
              setStatus(value);
              setCursor(undefined);
            }}
          >
            {value || "All"}
          </button>
        ))}
      </div>
      {loading && result && <p role="status">Loading battles…</p>}
      {loading && !result && (
        <SkeletonGroup label="Loading battles…" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="lifecycle-crew skeleton-card space-y-4" aria-hidden="true">
              <div className="flex justify-between"><Skeleton style={{ width: 120, height: 12 }} /><Skeleton style={{ width: 70, height: 24, borderRadius: 999 }} /></div>
              <Skeleton style={{ width: 190, height: 22 }} />
              <div className="grid grid-cols-3 gap-2">{[0, 1, 2, 3, 4, 5].map((n) => <Skeleton key={n} style={{ height: 64, borderRadius: 14 }} />)}</div>
              <Skeleton style={{ height: 44, borderRadius: 14 }} />
            </div>
          ))}
        </SkeletonGroup>
      )}
      {error && (
        <Card role="alert" className="border-neon-red text-neon-red">
          Battle reads unavailable: {error}
          {result && <p>Previous results are stale.</p>}
          <Button variant="ghost" onClick={() => setCursor(undefined)}>
            Restart list
          </Button>
        </Card>
      )}
      {result && (
        <>
          {(error || loading || !result.provenance.complete || result.provenance.health !== "healthy") && (
            <p role="status" className="text-xs text-mute">Battle information may be incomplete or out of date.</p>
          )}
          {result.provenance.kind === "fixture" && (
            <p className="text-xs text-mute">Fixture data · not live battles</p>
          )}
          {!result.data.items.length && (
            <div className="lifecycle-empty">
              <h3>No battles found.</h3>
              <p className="mt-2 text-sm text-mute">
                Try another search or create a new rivalry.
              </p>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {result.data.items.map((battle) => (
              <Card
                className="lifecycle-crew battle-preview-card"
                key={`${namespace.deploymentId}:${battle.battleId}`}
              >
                <div className="battle-preview-meta"><p className="eyebrow text-neon-green">
                  BATTLE #{battle.battleId} · {battle.enteredCount ?? battle.communities.length} ENTERED
                  {battle.pendingCount ? ` · ${battle.pendingCount} PENDING` : ""}
                </p><span className="battle-preview-status">{battle.status === "open" ? "Open to join" : battle.status === "decided" ? "Finished" : battle.status === "cancelled" ? "Cancelled" : "In progress"}</span></div>
                <h2 className="mt-3 text-xl">
                  <span className="sr-only">Battle #{battle.battleId}: </span>
                  {modeName(battle.mode)}
                </h2>
                <p className="mt-2 text-sm text-mute">
                  {battle.status === "open"
                    ? battle.startAtMs && /^[0-9]+$/.test(battle.startAtMs)
                      ? `Starts ${utc(Number(battle.startAtMs))}`
                      : "Ready to meet your crew"
                    : battle.status === "decided"
                      ? "The result is recorded"
                      : battle.status === "cancelled"
                        ? "Cancelled · depositors can claim a refund"
                        : "Crews locked in"}
                </p>
                <div className="battle-preview-roster">
                  {battle.communities.map((c) => (
                    <div key={c.index} title={c.representation} className="battle-preview-token">
                      {c.label ? (
                        <>
                          <TokenIcon symbol={displaySymbol(c.label, "")} size={44} />
                          <strong>{displaySymbol(c.label, "")}</strong>
                        </>
                      ) : (
                        communityName(c.index)
                      )}
                    </div>
                  ))}
                </div>
                {battle.winner !== null && (
                  <p className="mt-3 text-xs">
                    Recorded winner:{" "}
                    {battle.communities[battle.winner]?.label
                      ? displaySymbol(battle.communities[battle.winner]!.label, "")
                      : communityName(battle.winner)}
                  </p>
                )}
                <div className="battle-preview-enter grid gap-3">
                  <Button asChild variant="cyan">
                    <Link href={`/arena/${battle.battleId}`}>
                      Enter arena
                    </Link>
                  </Button>
                {battle.status !== "open" && battle.status !== "cancelled" && (
                  <>
                    <Button
                      variant="ghost"
                      aria-expanded={chartFor === battle.battleId}
                      onClick={() =>
                        setChartFor(
                          chartFor === battle.battleId ? null : battle.battleId,
                        )
                      }
                    >
                      {chartFor === battle.battleId
                        ? "Hide observations"
                        : "Show observations"}
                    </Button>
                    {chartFor === battle.battleId && (
                      <ObservationChart
                        namespace={namespace}
                        battleId={battle.battleId}
                      />
                    )}
                  </>
                )}
                </div>
              </Card>
            ))}
          </div>
          {result.data.nextCursor && (
            <Button
              variant="ghost"
              disabled={loading}
              onClick={() => setCursor(result.data.nextCursor!)}
            >
              Next page
            </Button>
          )}
        </>
      )}
    </section>
  );
}
