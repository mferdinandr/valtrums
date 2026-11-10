"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { useLifecycleCreate } from "@/hooks/use-lifecycle-create";
import type { Namespace } from "@/lib/arena-read/application";
import {
  buildDepositReview, buildRegisterReview, creditOutcome, depositRequest, registerRequest, type CreditState, type Review,
} from "@/lib/arena-read/deposit-flow";

interface CommunityOption {
  index: number;
  representation: string;
}

const CREDIT_TEXT: Record<CreditState, string> = {
  credited: "Credited: the arena reports this amount on your position.",
  partial: "Partly credited: the arena reports less than the amount you sent. The rest was refunded or is still in flight.",
  not_credited: "Not credited: the arena reports no change to your position. The transfer may have been refunded.",
  unknown: "Credit could not be read yet. The transaction is not a credited position until the arena reports it.",
};

/**
 * One reviewed wallet step. The reviewed call is compared with the service's canonical preview before
 * authorization (a mismatch stops the flow), the session token is memory-only and a rejection leaves the
 * review intact for a retry. `onPreviewed` and `onDone` let a step read the account's position around the
 * transaction without ever trusting the receipt as proof of credit.
 */
function Step({
  title, review, request, onPreviewed, onDone, children,
}: {
  title: string;
  review: Review;
  request: Record<string, unknown>;
  onPreviewed?: (actionId: string, read: (id: string) => Promise<{ registered: boolean; amount: string } | null>) => void;
  onDone?: (actionId: string, read: (id: string) => Promise<{ registered: boolean; amount: string } | null>) => void;
  children?: React.ReactNode;
}) {
  const { signIn } = useWallet();
  const run = useLifecycleCreate(request, review.ok ? review : null);
  const { flow } = run;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (flow.step === "previewed" && seen.current !== flow.previewed.record.actionId) {
      seen.current = flow.previewed.record.actionId;
      onPreviewed?.(flow.previewed.record.actionId, run.readPosition);
    }
    if (flow.step === "done" && flow.result.ok && flow.result.actionId) onDone?.(flow.result.actionId, run.readPosition);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);
  return (
    <div className="space-y-3">
      <p className="eyebrow text-neon-green">{title}</p>
      {!review.ok ? (
        <ul role="status" className="list-disc pl-4 text-sm text-neon-amber">{review.problems.map((p) => <li key={p}>{p}</li>)}</ul>
      ) : (
        <>
          <dl className="grid gap-1 text-xs sm:grid-cols-[12rem_1fr]">
            {review.lines.map((l) => (<div key={l.label} className="contents"><dt className="text-mute">{l.label}</dt><dd className="break-all">{l.value}</dd></div>))}
          </dl>
          <ul className="list-disc pl-4 text-xs text-mute">{review.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          {run.connected ? (
            <Button type="button" onClick={run.preview} disabled={flow.step === "previewing" || flow.step === "signing"}>
              {flow.step === "previewing" ? "Requesting preview…" : "Request canonical preview"}
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={() => void signIn()}>Connect wallet to sign</Button>
          )}
          {flow.step === "blocked" && (
            <ul role="alert" className="list-disc pl-4 text-xs text-neon-red">
              <li>The service preview does not match the reviewed call. Nothing was authorized.</li>
              {flow.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
          {flow.step === "previewed" && (
            <div role="status" className="space-y-2">
              <p className="text-xs text-neon-green">The service preview matches the reviewed call.</p>
              <p className="break-all text-xs text-mute">Preview {flow.previewed.record.previewHash}</p>
              <Button type="button" onClick={run.execute}>Authorize and sign with wallet</Button>
            </div>
          )}
          {flow.step === "signing" && <p role="status" className="text-xs text-mute">Waiting for the wallet and the verified receipt…</p>}
          {flow.step === "done" && (
            <p role={flow.result.ok ? "status" : "alert"} className={flow.result.ok ? "text-xs text-neon-green" : "text-xs text-neon-amber"}>
              {flow.result.ok
                ? `Receipt verified. Transaction ${flow.result.txHash}.`
                : `Not confirmed (${flow.result.status}): ${flow.result.reason}${flow.result.txHash ? ` Transaction ${flow.result.txHash} was submitted; it has no effect on your position until the receipt is verified.` : ""}`}
            </p>
          )}
          {flow.step === "error" && (
            <p role="alert" className="text-xs text-neon-red">{flow.message} <button type="button" className="underline" onClick={run.reset}>Try again</button></p>
          )}
          {children}
        </>
      )}
    </div>
  );
}

/**
 * Registration and deposit for an open lifecycle battle (issue #149). Two separate reviewed transactions:
 * a storage-paying position registration, then the representation `ft_transfer_call`. Neither is offered
 * on a locked battle. Eligibility (audit, backing, balance) is decided by the service and the arena; the
 * reasons they return are shown, not re-derived here.
 */
export function LifecycleParticipate({ namespace, battleId, communities, locked }: { namespace: Namespace; battleId: number; communities: CommunityOption[]; locked: boolean }) {
  const [community, setCommunity] = useState(0);
  const [amount, setAmount] = useState("");
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const selected = communities.find((c) => c.index === community) ?? communities[0];

  const registerReview = useMemo(() => buildRegisterReview(namespace.arenaContract, battleId, community), [namespace.arenaContract, battleId, community]);
  const registerReq = useMemo(() => registerRequest(battleId, community), [battleId, community]);
  const depositReview = useMemo(
    () => buildDepositReview({ arena: namespace.arenaContract, representation: selected?.representation ?? "", battleId, community, amount }),
    [namespace.arenaContract, selected?.representation, battleId, community, amount],
  );
  const depositReq = useMemo(() => depositRequest(battleId, community, amount), [battleId, community, amount]);

  // A different community or amount is a different transaction: forget the previous credit reading.
  useEffect(() => { setBefore(null); setAfter(null); }, [community, amount]);

  if (locked) {
    return <Card><CardTitle>Participate</CardTitle><p className="text-sm text-mute">This battle is locked. Positions can no longer be registered and a deposit would be returned.</p></Card>;
  }
  const credit = creditOutcome(before, after, /^[1-9][0-9]{0,38}$/.test(amount) ? amount : "1");
  return (
    <Card>
      <CardTitle>Participate</CardTitle>
      <p className="mb-4 text-xs text-mute">Two separate transactions. Nothing is signed until you approve the exact call shown, and a confirmed transaction is never treated as a credited position.</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Community">
        {communities.map((c) => (
          <Button key={c.index} type="button" variant="ghost" aria-pressed={community === c.index} onClick={() => setCommunity(c.index)} className={community === c.index ? "border-neon-green text-neon-green" : ""}>
            Community {c.index + 1}
          </Button>
        ))}
      </div>
      <div className="mt-6 space-y-8">
        <Step key={`register-${community}`} title="1 · REGISTER A POSITION (STORAGE, NOT A STAKE)" review={registerReview} request={registerReq} />
        <label className="block text-xs">
          <span className="text-mute">Amount in token base units (exact integer)</span>
          <input
            inputMode="numeric" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value.trim())}
            className="mt-1 block w-full rounded-lg border border-edge bg-transparent p-2 text-sm" aria-label="Deposit amount"
          />
        </label>
        <Step
          key={`deposit-${community}-${amount}`}
          title="2 · DEPOSIT THE REPRESENTATION"
          review={depositReview}
          request={depositReq}
          onPreviewed={(id, read) => void read(id).then((p) => setBefore(p ? p.amount : null))}
          onDone={(id, read) => void read(id).then((p) => setAfter(p ? p.amount : null))}
        >
          {after !== null || before !== null ? (
            <p role="status" className="text-xs">
              <Badge tone={credit.state === "credited" ? "green" : "amber"}>{credit.state.replace("_", " ")}</Badge>{" "}
              {CREDIT_TEXT[credit.state]}{credit.state !== "unknown" ? ` Change on your position: ${credit.delta} units.` : ""}
            </p>
          ) : null}
        </Step>
      </div>
    </Card>
  );
}
