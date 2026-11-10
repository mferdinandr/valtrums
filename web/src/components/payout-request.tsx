"use client";

import { useMemo, useState } from "react";
import { useWallet } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useLifecycleCreate } from "@/hooks/use-lifecycle-create";
import type { DeploymentFacts } from "@/hooks/use-portfolio";
import {
  RequestIdStore,
  buildPayoutReview,
  payoutGate,
  payoutRequest,
  reconcileGate,
  validatePayoutDraft,
  type Entitlement,
  type PayoutDraft,
  type PayoutRow,
} from "@/lib/arena-read/portfolio";

interface Prepared {
  draft: PayoutDraft;
  requestId: string;
  reused: boolean;
  persisted: boolean;
}

const browserStore = () => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

/**
 * Reviewed payout request. The control is disabled, with every unmet reason listed, unless the deployment's custody
 * capability is proven, a payout contract exists and the account has a positive entitlement for the chosen asset.
 * The request id is fixed before the preview and kept across reloads (only the id is stored; it carries no authority),
 * and a new request is blocked until payout status has been read and no same-asset same-amount payout is unresolved.
 * Status reads elsewhere on the page never depend on this control.
 */
export function PayoutRequest({
  deploymentId,
  namespaceKey,
  facts,
  entitlements,
  payouts,
  onChanged,
}: {
  deploymentId: string;
  namespaceKey: string;
  facts: DeploymentFacts | null;
  /** From the backing contracts via the account state; null until read. */
  entitlements: Entitlement[] | null;
  /** Null until payout status was read. */
  payouts: PayoutRow[] | null;
  onChanged: () => void;
}) {
  const { accountId, signIn } = useWallet();
  const [fields, setFields] = useState<PayoutDraft>({ backing: "", amount: "", destination: "" });
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const store = useMemo(() => new RequestIdStore(browserStore()), []);

  const payoutContract = facts?.capabilities?.companions.payout ?? null;
  const review = useMemo(() => (prepared ? buildPayoutReview(payoutContract, prepared.draft, prepared.requestId) : null), [prepared, payoutContract]);
  const request = useMemo(() => (prepared ? payoutRequest(prepared.draft, prepared.requestId) : {}), [prepared]);
  const run = useLifecycleCreate(request, review && review.ok ? review : null, `${namespaceKey}:payout`);
  const { flow } = run;

  const problems = validatePayoutDraft(fields);
  const gate = payoutGate({ connected: run.connected, capabilities: facts?.capabilities ?? null, custody: facts?.custody ?? null, entitlements, draft: fields });
  const reconcile = reconcileGate(payouts, fields);
  const blocked = [...(gate.enabled ? [] : gate.reasons), ...problems, ...reconcile];
  const busy = flow.step === "previewing" || flow.step === "signing";

  const edit = (patch: Partial<PayoutDraft>) => {
    setFields((f) => ({ ...f, ...patch }));
    // Any change is a different request: the reviewed call, its id and any pending preview are dropped.
    setPrepared(null);
    run.reset();
  };
  const prepare = () => {
    if (!accountId || blocked.length > 0) return;
    const got = store.obtain(accountId, deploymentId, fields);
    setPrepared({ draft: { ...fields }, ...got });
  };
  const discard = () => {
    if (!accountId || !prepared) return;
    store.release(accountId, deploymentId, prepared.draft);
    setPrepared(null);
    run.reset();
  };

  return (
    <Card className="space-y-4 p-4" aria-label="Payout request">
      <h2 className="text-lg text-neon-green">Request a payout (original token on Robinhood Chain)</h2>
      {facts?.error && <p className="text-sm text-neon-amber">Deployment facts partly unavailable: {facts.error}</p>}
      {!gate.enabled && (
        <div role="status" className="space-y-1" data-testid="payout-disabled">
          <Badge tone="amber">payout requests disabled</Badge>
          <ul className="list-disc pl-4 text-base text-mute">
            {gate.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="text-sm text-mute">Payout status, transfers and recovery alerts above stay readable while requests are disabled.</p>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm text-mute">
          Original asset (backing)
          <Input value={fields.backing} onChange={(e) => edit({ backing: e.target.value.trim() })} placeholder="representation account, e.g. pepe.rep.testnet" list="payout-backings" />
          <datalist id="payout-backings">
            {(entitlements ?? []).map((e) => (
              <option key={e.backing} value={e.backing} />
            ))}
          </datalist>
        </label>
        <label className="space-y-1 text-sm text-mute">
          Amount (integer base units)
          <Input inputMode="numeric" value={fields.amount} onChange={(e) => edit({ amount: e.target.value.trim() })} placeholder="e.g. 100" />
        </label>
        <label className="space-y-1 text-sm text-mute sm:col-span-2">
          Destination (20-byte address on the source chain)
          <Input value={fields.destination} onChange={(e) => edit({ destination: e.target.value.trim() })} placeholder="0x…" />
        </label>
      </div>
      {fields.amount !== "" || fields.destination !== "" || fields.backing !== "" ? (
        <ul className="list-disc pl-4 text-sm text-neon-amber" aria-label="Request problems">
          {[...problems, ...reconcile].map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {!run.connected ? (
        <Button type="button" variant="ghost" onClick={() => void signIn()}>
          Connect wallet to request
        </Button>
      ) : (
        <Button type="button" onClick={prepare} disabled={blocked.length > 0 || busy}>
          Review request
        </Button>
      )}
      {prepared && review && (
        <div className="space-y-3">
          {!review.ok ? (
            <ul role="alert" className="list-disc pl-4 text-sm text-neon-red">
              {review.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : (
            <>
              <dl className="grid gap-1 text-xs sm:grid-cols-[14rem_1fr]">
                {review.lines.map((l) => (
                  <div key={l.label} className="contents">
                    <dt className="text-mute">{l.label}</dt>
                    <dd className="break-all">{l.value}</dd>
                  </div>
                ))}
              </dl>
              <ul className="list-disc pl-4 text-xs text-mute">
                {review.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
                <li>
                  {prepared.reused ? "This request id was kept from an earlier attempt: a retry cannot create a second payout." : "A new request id was created for this request."}{" "}
                  {prepared.persisted ? "It is saved in this browser (the id only)." : "Browser storage is unavailable: the id is kept for this page only, so do not reload before the status is known."}
                </li>
              </ul>
              <Button type="button" onClick={run.preview} disabled={busy}>
                {flow.step === "previewing" ? "Checking your review…" : "Check transaction preview"}
              </Button>
            </>
          )}
          {flow.step === "blocked" && (
            <ul role="alert" className="list-disc pl-4 text-xs text-neon-red">
              <li>The service preview does not match the reviewed call. Nothing was authorized.</li>
              {flow.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {flow.step === "previewed" && (
            <div role="status" className="space-y-2">
              <p className="text-xs text-neon-green">The service preview matches the reviewed call.</p>
              <p className="break-all text-xs text-mute">Preview {flow.previewed.record.previewHash}</p>
              <Button type="button" onClick={run.execute} disabled={busy || !gate.enabled}>
                Authorize and sign with wallet
              </Button>
            </div>
          )}
          {flow.step === "signing" && (
            <p role="status" className="text-xs text-mute">
              Waiting for the wallet and the verified receipt…
            </p>
          )}
          {flow.step === "done" && (
            <div role={flow.result.ok ? "status" : "alert"} className={flow.result.ok ? "space-y-2 text-xs text-neon-green" : "space-y-2 text-xs text-neon-amber"}>
              <p>
                {flow.result.ok
                  ? `The payout request transaction is verified (${flow.result.txHash}). This is a request, not a payment: it is paid only when its transfer is confirmed below.`
                  : `Not confirmed (${flow.result.status}): ${flow.result.reason}${flow.result.txHash ? ` Transaction ${flow.result.txHash} was submitted; refresh the status before doing anything else.` : ""}`}
              </p>
              <Button type="button" variant="ghost" onClick={onChanged}>
                Refresh payout status
              </Button>
            </div>
          )}
          {flow.step === "error" && (
            <p role="alert" className="text-xs text-neon-red">
              {flow.message} Your review is unchanged; nothing was retried automatically and the same request id stays in use.
            </p>
          )}
          {!busy && (
            <Button type="button" variant="ghost" onClick={discard}>
              Discard this request id (only when you are sure nothing was submitted)
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
