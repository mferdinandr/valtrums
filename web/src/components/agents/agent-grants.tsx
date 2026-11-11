"use client";
import { TransactionLink } from "@/components/transaction-link";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useActionWallet, useWallet } from "@/components/providers";
import { Select } from "@/components/ui/select";
import { TokenChip, TokenPicker, assetSymbol, type RegistryAsset } from "@/components/token-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import type { Namespace } from "@/lib/arena-read/application";
import {
  addSavedGrant, buildAgentConfig, buildGrantReview, buildRevokeReview, emptyGrantForm, gasUnits, parseSavedGrants, randomLocalId, readGrantStatus, savedGrantsKey,
  STRATEGY_OPTIONS, type AgentStrategy, type GrantForm, type GrantStatus, type SavedGrant,
} from "@/lib/arena-read/agent-grant";
import type { CallReview } from "@/lib/arena-read/create-review";
import { config } from "@/lib/config";

type Tx = { step: "idle" } | { step: "signing" } | { step: "done"; hash: string | null } | { step: "error"; message: string };

const NO_CHOSEN: ReadonlySet<string> = new Set();

function Lines({ review }: { review: CallReview }) {
  return (
    <>
      <dl className="space-y-1 text-sm">
        {review.lines.map((l) => (
          <div key={l.label} className="flex flex-col gap-0 sm:flex-row sm:gap-4">
            <dt className="w-48 shrink-0 text-mute">{l.label}</dt>
            <dd className="break-all">{l.value}</dd>
          </div>
        ))}
      </dl>
      {review.notes.map((n) => (
        <p key={n} className="mt-2 text-xs text-mute">{n}</p>
      ))}
      <details className="lifecycle-tech">
        <summary>Exact transaction arguments</summary>
        <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-edge p-3 text-xs" aria-label="Exact arguments">
          {JSON.stringify(review.args, null, 2)}
        </pre>
      </details>
    </>
  );
}

const tone = (s: GrantStatus["state"]) => (s === "active" ? "green" : s === "missing" ? "mute" : "amber");

export function AgentGrants({ namespace }: { namespace: Namespace }) {
  const { accountId, signIn } = useWallet();
  const getWallet = useActionWallet();
  const policy = config.policyContract;
  const [form, setForm] = useState<GrantForm>(emptyGrantForm());
  const [picked, setPicked] = useState<string>("");
  const [strategy, setStrategy] = useState<AgentStrategy>("crowd");
  const [localId, setLocalId] = useState<number[]>(() => randomLocalId());
  const [tx, setTx] = useState<Tx>({ step: "idle" });
  const [saved, setSaved] = useState<SavedGrant[]>([]);
  const [statuses, setStatuses] = useState<Record<string, GrantStatus | { error: string }>>({});
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeTx, setRevokeTx] = useState<Tx>({ step: "idle" });

  const set = (patch: Partial<GrantForm>) => {
    setTx({ step: "idle" });
    setForm((f) => ({ ...f, ...patch }));
  };
  const nowMs = useMemo(() => Date.now(), [form]); // eslint-disable-line react-hooks/exhaustive-deps
  const review = useMemo(
    () => buildGrantReview(form, { policy, arena: namespace.arenaContract, user: accountId, nowMs, localId }),
    [form, policy, namespace.arenaContract, accountId, nowMs, localId],
  );

  useEffect(() => {
    if (!accountId) return setSaved([]);
    try {
      setSaved(parseSavedGrants(localStorage.getItem(savedGrantsKey(accountId))));
    } catch {
      setSaved([]);
    }
  }, [accountId]);

  const persist = (list: SavedGrant[]) => {
    setSaved(list);
    if (!accountId) return;
    try {
      localStorage.setItem(savedGrantsKey(accountId), JSON.stringify(list));
    } catch {
      // Storage can be unavailable; the grant still exists on chain and can be re-added by id.
    }
  };

  const refresh = useCallback(async () => {
    if (!accountId || !policy) return;
    const next: Record<string, GrantStatus | { error: string }> = {};
    await Promise.all(
      saved.map(async (g) => {
        try {
          next[g.localIdHex] = await readGrantStatus(config.rpcUrl, policy, accountId, g.localIdHex, Date.now());
        } catch (e) {
          next[g.localIdHex] = { error: e instanceof Error ? e.message : "read failed" };
        }
      }),
    );
    setStatuses(next);
  }, [accountId, policy, saved]);
  useEffect(() => void refresh(), [refresh]);

  const send = async (call: CallReview, setState: (t: Tx) => void): Promise<boolean> => {
    setState({ step: "signing" });
    try {
      if (!getWallet) throw new Error("connect a wallet first");
      const wallet = await getWallet();
      const out = await wallet.signAndSendTransaction({
        receiverId: call.receiver,
        actions: [{ type: "FunctionCall", params: { methodName: call.method, args: call.args as object, gas: gasUnits(call.gasTgas), deposit: call.depositYocto } }],
      });
      const hash = (out as { transaction?: { hash?: string } } | null)?.transaction?.hash ?? null;
      setState({ step: "done", hash });
      return true;
    } catch (e) {
      setState({ step: "error", message: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  const createGrant = async () => {
    if (!review.ok) return;
    if (await send(review, setTx)) {
      persist(addSavedGrant(saved, { localIdHex: review.localIdHex, createdAtMs: Date.now(), label: picked || "token", delegate: form.delegate, strategy, mappingVersion: form.mappingVersion }));
      setLocalId(randomLocalId());
      setTimeout(() => void refresh(), 4000);
    }
  };

  const revoke = async (hex: string) => {
    const r = buildRevokeReview(policy, hex);
    if (!r.ok) return;
    if (await send(r, setRevokeTx)) {
      setRevoking(null);
      setTimeout(() => void refresh(), 4000);
    }
  };

  const onPick = (p: RegistryAsset) => {
    setPicked(assetSymbol(p));
    set({ chainId: p.chainId, token: p.token });
  };

  if (!policy) {
    return (
      <Card role="alert">
        The player-policy contract is not configured. Set <code>NEXT_PUBLIC_PLAYER_POLICY_CONTRACT_ID</code> in{" "}
        <code>web/.env.local</code> and restart the dev server.
      </Card>
    );
  }

  const busy = tx.step === "signing";
  return (
    <div className="space-y-6">
      <Card className="space-y-4">
        <CardTitle>01 / Give an agent a budget</CardTitle>
        <div className="token-chips" aria-label="Chosen token">
          {picked ? <TokenChip symbol={picked} onRemove={() => { setPicked(""); set({ chainId: "", token: "" }); }} /> : <span className="text-xs text-mute">Pick the token the agent may play with.</span>}
        </div>
        <TokenPicker namespace={namespace} chosen={form.token ? new Set([`${form.chainId}:${form.token.toLowerCase()}`]) : NO_CHOSEN} full={!!picked} onPick={onPick} />
        <fieldset disabled={busy} className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Label>
            Agent account (NEAR)
            <Input value={form.delegate} maxLength={64} placeholder="agent.testnet" onChange={(e) => set({ delegate: e.target.value.trim().toLowerCase() })} />
          </Label>
          <Label>
            Representation (NEAR account of the NEP-141 token)
            <Input value={form.representation} maxLength={64} onChange={(e) => set({ representation: e.target.value.trim().toLowerCase() })} />
          </Label>
          <div className="sm:col-span-2">
            <span className="mb-2 block font-pixel text-xs font-medium text-mute">
              Strategy (how the agent chooses; it carries no authority, the limits below do)
            </span>
            <Select<AgentStrategy>
              label="Strategy"
              value={strategy}
              options={STRATEGY_OPTIONS}
              onChange={setStrategy}
              disabled={busy}
            />
          </div>
          <Label>
            Per-action limit (base units)
            <Input inputMode="numeric" autoComplete="off" value={form.perAction} onChange={(e) => set({ perAction: e.target.value.trim() })} />
          </Label>
          <Label>
            Total budget (base units)
            <Input inputMode="numeric" autoComplete="off" value={form.cumulative} onChange={(e) => set({ cumulative: e.target.value.trim() })} />
          </Label>
          <Label>
            Valid for (days)
            <Input inputMode="numeric" value={form.days} onChange={(e) => set({ days: e.target.value.trim() })} />
          </Label>
          <Label>
            Only battle # (optional)
            <Input inputMode="numeric" value={form.battleId} placeholder="any battle" onChange={(e) => set({ battleId: e.target.value.trim() })} />
          </Label>
          <details className="lifecycle-tech sm:col-span-2">
            <summary>Advanced</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <Label>
                Custody domain
                <Input value={form.custodyDomain} maxLength={64} onChange={(e) => set({ custodyDomain: e.target.value })} />
              </Label>
              <Label>
                Mapping version
                <Input inputMode="numeric" value={form.mappingVersion} onChange={(e) => set({ mappingVersion: e.target.value.trim() })} />
              </Label>
              <Label>
                Gas per action (Tgas)
                <Input inputMode="numeric" value={form.gasCapTgas} onChange={(e) => set({ gasCapTgas: e.target.value.trim() })} />
              </Label>
            </div>
          </details>
        </fieldset>
      </Card>

      <Card aria-label="Grant review">
        <CardTitle>02 / Review before you sign</CardTitle>
        {!review.ok ? (
          <details className="lifecycle-tech">
            <summary>Complete the form to review your agent</summary>
            <ul className="list-disc pl-4 text-sm text-neon-amber">
              {[...new Set(review.problems)].map((p) => <li key={p}>{p}</li>)}
            </ul>
          </details>
        ) : (
          <>
            <Lines review={review} />
            <div className="mt-4 flex flex-wrap gap-2">
              {accountId ? (
                <Button type="button" onClick={() => void createGrant()} disabled={busy}>
                  {busy ? "Waiting for the wallet…" : "Create grant with wallet"}
                </Button>
              ) : (
                <Button type="button" variant="ghost" onClick={() => void signIn()}>Connect wallet to sign</Button>
              )}
            </div>
          </>
        )}
        {tx.step === "done" && (
          <p role="status" className="mt-3 text-xs text-neon-green">
            Submitted{tx.hash ? ` (transaction ${tx.hash})` : ""}. It is a grant only once the chain reports it below.
            <TransactionLink hash={tx.hash} />
          </p>
        )}
        {tx.step === "error" && <p role="alert" className="mt-3 text-xs text-neon-red">{tx.message}</p>}
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Your agents</CardTitle>
          <Button type="button" variant="ghost" onClick={() => void refresh()} disabled={!accountId || saved.length === 0}>Refresh</Button>
        </div>
        {!accountId && <p className="text-sm text-mute">Connect your wallet to see the grants you created in this browser.</p>}
        {accountId && saved.length === 0 && <p className="text-sm text-mute">No grants yet. The contract cannot list grants by owner, so grants created here are remembered in this browser.</p>}
        <ul className="space-y-3">
          {saved.map((g) => {
            const s = statuses[g.localIdHex];
            const status = s && !("error" in s) ? s : null;
            return (
              <li key={g.localIdHex} className="rounded-xl border border-edge p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{g.label}</strong>
                  {status ? <Badge tone={tone(status.state)}>{status.state}</Badge> : <Badge tone="mute">{s ? "unreadable" : "reading…"}</Badge>}
                  <span className="break-all text-xs text-mute">{g.localIdHex}</span>
                </div>
                {s && "error" in s && <p role="alert" className="mt-2 text-xs text-neon-red">Could not read this grant: {s.error}</p>}
                {status?.state === "missing" && <p className="mt-2 text-xs text-mute">The chain reports no such grant yet. If you just signed, wait a few seconds and refresh.</p>}
                {status && status.state !== "missing" && (
                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                    <div><dt className="inline text-mute">Agent: </dt><dd className="inline break-all">{status.delegate}</dd></div>
                    <div><dt className="inline text-mute">Valid until: </dt><dd className="inline">{status.expiresAtMs ? new Date(status.expiresAtMs).toISOString() : "?"}</dd></div>
                    <div><dt className="inline text-mute">Per action: </dt><dd className="inline">{status.perActionCap}</dd></div>
                    <div><dt className="inline text-mute">Gas per action: </dt><dd className="inline">{status.gasCapTgas} Tgas</dd></div>
                    {status.budget && (
                      <>
                        <div><dt className="inline text-mute">Total budget: </dt><dd className="inline">{status.budget.authorizedLimit}</dd></div>
                        <div><dt className="inline text-mute">Available: </dt><dd className="inline">{status.budget.available}</dd></div>
                        <div><dt className="inline text-mute">Reserved: </dt><dd className="inline">{status.budget.reserved}</dd></div>
                        <div><dt className="inline text-mute">Consumed: </dt><dd className="inline">{status.budget.consumed}</dd></div>
                      </>
                    )}
                  </dl>
                )}
                {accountId && (() => {
                  const cfg = buildAgentConfig(g, accountId);
                  return cfg ? (
                    <details className="lifecycle-tech mt-3">
                      <summary>Agent config · copy into the agent program</summary>
                      <p className="mt-2 text-xs text-mute">
                        Save as the agent config file and set <code>{String(cfg.agents[0]!.keyEnv)}</code> to the agent account&apos;s key in the
                        agent&apos;s own environment. The key is never shown here or sent anywhere. Run:{" "}
                        <code>pnpm -C agent player:run --config &lt;file&gt;</code> (dry run by default).
                      </p>
                      <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-edge p-3 text-xs" aria-label="Agent config">
                        {JSON.stringify(cfg, null, 2)}
                      </pre>
                      <Button type="button" variant="ghost" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(cfg, null, 2))}>
                        Copy config
                      </Button>
                    </details>
                  ) : null;
                })()}
                {status && (status.state === "active" || status.state === "expired") && (
                  <div className="mt-3">
                    {revoking === g.localIdHex ? (
                      <div className="space-y-2">
                        {(() => {
                          const r = buildRevokeReview(policy, g.localIdHex);
                          return r.ok ? <Lines review={r} /> : null;
                        })()}
                        <div className="flex gap-2">
                          <Button type="button" onClick={() => void revoke(g.localIdHex)} disabled={revokeTx.step === "signing"}>
                            {revokeTx.step === "signing" ? "Waiting for the wallet…" : "Revoke with wallet"}
                          </Button>
                          <Button type="button" variant="ghost" onClick={() => { setRevoking(null); setRevokeTx({ step: "idle" }); }}>Cancel</Button>
                        </div>
                        {revokeTx.step === "error" && <p role="alert" className="text-xs text-neon-red">{revokeTx.message}</p>}
                      </div>
                    ) : (
                      <Button type="button" variant="ghost" onClick={() => { setRevoking(g.localIdHex); setRevokeTx({ step: "idle" }); }}>Revoke…</Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
