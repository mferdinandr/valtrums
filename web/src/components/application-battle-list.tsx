"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useApplicationSearch } from "@/hooks/use-application-search";
import type { Namespace, ApplicationBattlePage } from "@/lib/arena-read/application";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { ObservationChart } from "@/components/battle-chart/observation-chart";

/** Lifecycle reads retain their own DTO; never reinterpret them as legacy A/B economics. */
export function ApplicationBattleList({ namespace }: { namespace: Namespace }) {
  const [chartFor, setChartFor] = useState<string | null>(null);
  const [q, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const { result, loading, error } = useApplicationSearch<ApplicationBattlePage>(namespace, "battles", { q, status, cursor });
  return <section className="space-y-5" aria-label="Application battles">
    <div><p className="eyebrow text-neon-green">THE BATTLE LINE-UP</p><h1 className="mt-3 text-3xl">Find your next rivalry.</h1>
      <p className="mt-3 text-sm text-mute">{namespace.deploymentId} · {namespace.network} · {namespace.arenaContract} · {namespace.protocol}</p>
      <p className="mt-3"><Link href="/arena/new" className="underline">Review a new lifecycle battle</Link></p></div>
    <label className="arena-search"><Search size={16} aria-hidden="true" /><span className="sr-only">Search community or battle ID</span>
      <input value={q} maxLength={64} placeholder="Search community or battle ID" onChange={(e) => { setQuery(e.target.value); setCursor(undefined); }} /></label>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by battle status">
      {["", "open", "locked", "decided"].map((value) => <button key={value} aria-pressed={status === value}
        className={cn("rounded-lg border px-4 py-2 text-xs", status === value ? "border-neon-green text-neon-green" : "border-edge text-mute")}
        onClick={() => { setStatus(value); setCursor(undefined); }}>{value || "All"}</button>)}
    </div>
    {loading && <p role="status">Loading battles…</p>}
    {error && <Card role="alert" className="border-neon-red text-neon-red">Battle reads unavailable: {error}
      {result && <p>Previous results are stale.</p>}
      <Button variant="ghost" onClick={() => setCursor(undefined)}>Restart list</Button></Card>}
    {result && <>
      <p className="text-xs text-mute">{result.provenance.kind} · {error || loading ? "stale" : result.provenance.health} · {result.provenance.complete ? "complete" : "partial"}</p>
      {result.provenance.reasons.map((reason) => <p className="text-xs text-mute" key={reason}>{reason}</p>)}
      {!result.data.items.length && <p>No battles in this backend page.</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{result.data.items.map((battle) => <Card key={`${namespace.deploymentId}:${battle.battleId}`}>
        <h2><Link href={`/arena/${battle.battleId}`} className="underline">Battle #{battle.battleId}</Link></h2><p className="mt-2 text-sm">{battle.mode} · {battle.status}</p>
        <p className="mt-2 break-all text-xs text-mute">Creator: {battle.creator}</p>
        {battle.communities.map((c) => <p key={c.index} className="mt-3 break-all text-xs">{c.representation}<br />{c.chainId}:{c.tokenAddress}</p>)}
        {battle.winner !== null && <p className="mt-3 text-xs">Recorded winner: community {battle.winner}</p>}
        {battle.status !== "open" && <>
          <Button variant="ghost" aria-expanded={chartFor === battle.battleId} onClick={() => setChartFor(chartFor === battle.battleId ? null : battle.battleId)}>
            {chartFor === battle.battleId ? "Hide observations" : "Show observations"}</Button>
          {chartFor === battle.battleId && <ObservationChart namespace={namespace} battleId={battle.battleId} />}
        </>}
      </Card>)}</div>
      {result.data.nextCursor && <Button variant="ghost" disabled={loading} onClick={() => setCursor(result.data.nextCursor!)}>Next page</Button>}
    </>}
  </section>;
}
