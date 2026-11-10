"use client";

import { useState } from "react";
import Link from "next/link";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { useApplicationSearch } from "@/hooks/use-application-search";
import type { ApplicationPage, Namespace } from "@/lib/arena-read/application";
import { buildCreateReview, MAX_COMMUNITIES, MIN_COMMUNITIES, SCORING_MODES, type AssetDraft } from "@/lib/arena-read/create-review";

interface RegistryAsset { chainId: string; token: string; referenceChainId: string; referenceToken: string; assetKey: string; registryVersion: string }

const empty = (): AssetDraft => ({ chainId: "", tokenAddress: "", representation: "", custodyDomain: "", referenceChainId: "", referenceAddress: "" });

/** Backend-searched pick from the protocol's reference registry. Identity comes from the registry entry, never from typing. */
function AssetPicker({ namespace, onPick }: { namespace: Namespace; onPick: (a: RegistryAsset) => void }) {
  const [q, setQ] = useState("");
  const { result, loading, error } = useApplicationSearch<ApplicationPage<RegistryAsset>>(namespace, "assets", { q, limit: 8 });
  return (
    <div className="space-y-2">
      <Label>Search registered assets<Input value={q} maxLength={64} placeholder="chain:token or reference address" onChange={(e) => setQ(e.target.value)} /></Label>
      {loading && <p role="status" className="text-xs text-mute">Searching…</p>}
      {error && <p role="alert" className="text-xs text-neon-red">Asset search unavailable: {error}</p>}
      {result && !loading && result.data.items.length === 0 && <p className="text-xs text-mute">No registered asset matches. Registry membership is required.</p>}
      <ul className="space-y-1">
        {result?.data.items.map((a) => (
          <li key={a.assetKey}>
            <Button variant="ghost" type="button" onClick={() => onPick(a)} className="break-all text-left text-xs">
              {a.chainId}:{a.token} → reference {a.referenceChainId}:{a.referenceToken}
            </Button>
          </li>
        ))}
      </ul>
      {result && <p className="text-xs text-mute">Registry membership is not audit, backing or deposit eligibility.</p>}
    </div>
  );
}

/**
 * Review of `create_lifecycle_battle` for an application deployment. It shows the exact arguments and
 * costs. It does NOT sign or send: wallet signing of lifecycle actions needs the NEP-413 action session
 * that this client does not provide yet, so nothing leaves this page and no funds can move from it.
 */
export function LifecycleCreateReview({ namespace }: { namespace: Namespace }) {
  const [mode, setMode] = useState<string>("PriceGain");
  const [assets, setAssets] = useState<AssetDraft[]>([empty(), empty()]);
  const [copied, setCopied] = useState(false);
  const review = buildCreateReview(namespace.arenaContract, assets, mode);
  const set = (i: number, patch: Partial<AssetDraft>) => setAssets((all) => all.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  // Hide "nothing picked yet" noise until at least one field has been touched.
  const touched = assets.some((a) => a.tokenAddress || a.representation || a.custodyDomain);
  return (
    <div className="space-y-6">
      <Link href="/arena" className="text-xs text-neon-green">← Back to battles</Link>
      <section className="pixel-frame p-6">
        <p className="eyebrow text-neon-green">NEW LIFECYCLE BATTLE / REVIEW</p>
        <h1 className="mt-3 text-3xl">Review a battle before you sign</h1>
        <p className="mt-3 text-sm text-mute">{namespace.deploymentId} · {namespace.network} · {namespace.arenaContract}</p>
        <p className="mt-3 text-sm text-neon-amber">Review only: this page does not sign or send anything. Rounds last 30 seconds and there is no bond or duration to choose.</p>
      </section>

      <Card>
        <CardTitle>Scoring mode</CardTitle>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Scoring mode">
          {SCORING_MODES.map((m) => (
            <Button key={m} variant="ghost" type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={mode === m ? "border-neon-green text-neon-green" : ""}>{m}</Button>
          ))}
        </div>
        <p className="mt-3 text-xs text-mute">Whether a mode can run live depends on provider qualification; the arena and oracle report that, this page does not.</p>
      </Card>

      {assets.map((a, i) => (
        <Card key={i} className="space-y-3">
          <CardTitle>Community {i + 1}</CardTitle>
          <AssetPicker namespace={namespace} onPick={(p) => set(i, { chainId: p.chainId, tokenAddress: p.token, referenceChainId: p.referenceChainId, referenceAddress: p.referenceToken })} />
          <p className="break-all text-xs">{a.tokenAddress ? `Asset ${a.chainId}:${a.tokenAddress} · reference ${a.referenceChainId || "none"}:${a.referenceAddress || "none"}` : "No asset picked yet."}</p>
          <Label>Representation (NEAR account of the NEP-141 token)<Input value={a.representation} maxLength={64} onChange={(e) => set(i, { representation: e.target.value.trim().toLowerCase() })} /></Label>
          <Label>Custody domain<Input value={a.custodyDomain} maxLength={64} onChange={(e) => set(i, { custodyDomain: e.target.value })} /></Label>
          {assets.length > MIN_COMMUNITIES && <Button variant="ghost" type="button" onClick={() => setAssets((all) => all.filter((_, j) => j !== i))}><Trash2 size={14} aria-hidden="true" /> Remove community {i + 1}</Button>}
        </Card>
      ))}
      {assets.length < MAX_COMMUNITIES && <Button variant="ghost" type="button" onClick={() => setAssets((all) => [...all, empty()])}><Plus size={14} aria-hidden="true" /> Add community</Button>}

      <Card aria-label="Transaction review">
        <CardTitle>Exact transaction</CardTitle>
        {!review.ok ? (
          touched ? <ul role="status" className="list-disc pl-4 text-sm text-neon-amber">{review.problems.map((p) => <li key={p}>{p}</li>)}</ul> : <p className="text-sm text-mute">Pick at least two assets and fill their representation and custody domain.</p>
        ) : (
          <>
            <dl className="space-y-1 text-sm">
              {review.lines.map((l) => (
                <div key={l.label} className="flex flex-col gap-0 sm:flex-row sm:gap-4"><dt className="w-48 shrink-0 text-mute">{l.label}</dt><dd className="break-all">{l.value}</dd></div>
              ))}
            </dl>
            {review.notes.map((n) => <p key={n} className="mt-2 text-xs text-mute">{n}</p>)}
            <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-edge p-3 text-xs" aria-label="Exact arguments">{JSON.stringify(review.args, null, 2)}</pre>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="ghost" type="button" onClick={async () => { await navigator.clipboard?.writeText(JSON.stringify(review.args)); setCopied(true); }}>{copied ? "Copied" : "Copy exact arguments"}</Button>
              <Button type="button" disabled aria-describedby="sign-disabled">Sign with wallet</Button>
            </div>
            <p id="sign-disabled" className="mt-2 text-xs text-neon-amber">Signing is not enabled in this client yet: lifecycle actions need the NEP-413 action session. Nothing was sent.</p>
          </>
        )}
      </Card>
    </div>
  );
}
