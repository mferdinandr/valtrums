"use client";

import { useState } from "react";
import { ArrowUpRight, Plus, Search } from "lucide-react";
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
      <header className="lifecycle-hero">
        <div>
          <span className="lifecycle-pill">THE COMMUNITY FAIRGROUND</span>
          <h1>Find your next rivalry.</h1>
          <p className="text-sm text-mute">
            Meet the crews, pick your community and step into its 3D arena.
            Watch the round unfold, then inspect the recorded result.
          </p>
          <div className="lifecycle-actions">
            <Button asChild>
              <Link href="/arena/new">
                <Plus size={16} /> Create a battle
              </Link>
            </Button>
            <span className="text-xs text-mute">Watching needs no wallet.</span>
          </div>
          <details className="lifecycle-tech">
            <summary>Connected arena</summary>
            {namespace.deploymentId} · {namespace.network} ·{" "}
            {namespace.arenaContract} · {namespace.protocol}
          </details>
        </div>
        <CarnivalScene
          mode="arena"
          caption="Your fairground hosts · decorative, not battle evidence"
        />
      </header>
      <div className="lifecycle-heading">
        <h2>The battle line-up</h2>
        <p className="text-xs text-mute">Every crew. One arena.</p>
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
        {["", "open", "locked", "decided"].map((value) => (
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
      {loading && <p role="status">Loading battles…</p>}
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
          <p className="text-xs text-mute">
            {result.provenance.kind} ·{" "}
            {error || loading ? "stale" : result.provenance.health} ·{" "}
            {result.provenance.complete ? "complete" : "partial"}
          </p>
          {result.provenance.reasons.map((reason) => (
            <p className="text-xs text-mute" key={reason}>
              {reason}
            </p>
          ))}
          {!result.data.items.length && (
            <div className="lifecycle-empty">
              <h3>No crews on this page yet.</h3>
              <p className="mt-2 text-sm text-mute">
                Try another search or create a new rivalry.
              </p>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {result.data.items.map((battle) => (
              <Card
                className="lifecycle-crew"
                key={`${namespace.deploymentId}:${battle.battleId}`}
              >
                <p className="eyebrow text-neon-green">
                  BATTLE #{battle.battleId} · {battle.communities.length} CREWS
                </p>
                <h2 className="mt-3 text-xl">
                  <span className="sr-only">Battle #{battle.battleId}: </span>
                  {modeName(battle.mode)}
                </h2>
                <p className="mt-2 text-sm text-mute">
                  {battle.status === "open"
                    ? "Ready to meet your crew"
                    : battle.status === "decided"
                      ? "The result is recorded"
                      : "Crews locked in"}
                </p>
                <div className="lifecycle-facts">
                  {battle.communities.map((c) => (
                    <span key={c.index} title={c.representation}>
                      {communityName(c.index)}
                    </span>
                  ))}
                </div>
                {battle.winner !== null && (
                  <p className="mt-3 text-xs">
                    Recorded winner: {communityName(battle.winner)}
                  </p>
                )}
                <div className="lifecycle-actions">
                  <Button asChild variant="cyan">
                    <Link href={`/arena/${battle.battleId}`}>
                      Enter arena <ArrowUpRight size={15} />
                    </Link>
                  </Button>
                </div>
                <details className="lifecycle-tech">
                  <summary>Community contracts</summary>
                  <p>Creator: {shortAccount(battle.creator)}</p>
                  {battle.communities.map((c) => (
                    <p key={c.index}>
                      {c.representation}
                      <br />
                      {c.chainId}:{c.tokenAddress}
                    </p>
                  ))}
                </details>
                {battle.status !== "open" && (
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
