"use client";
import { TransactionLink } from "@/components/transaction-link";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/input";
import { useLifecycleCreate } from "@/hooks/use-lifecycle-create";
import { useJoinableAssets } from "@/hooks/use-joinable-assets";
import { useNow } from "@/hooks/use-now";
import { config } from "@/lib/config";
import { applicationKey, fetchApplication, type ApplicationPage, type Namespace } from "@/lib/arena-read/application";
import { buildCreateReview, type CallReview } from "@/lib/arena-read/create-review";
import { buildCancelReview, buildJoinReview, buildRefundReview, openPhase } from "@/lib/arena-read/open-arena";
import {
  buildDepositReview,
  buildRegisterReview,
  creditOutcome,
  type CreditState,
  type Review,
} from "@/lib/arena-read/deposit-flow";
import { battleStatus, communityRows, fetchLifecycleBattle, type LifecycleDetail } from "@/lib/arena-read/lifecycle";
import { MODE_COPY } from "@/lib/arena-read/lifecycle-presentation";
import {
  MAX_PROMPT_CHARS,
  describeIntent,
  intentToRequest,
  type LifecycleIntent,
  type LifecycleParseResult,
} from "@/lib/terminal/lifecycle-intent";
import { createLifecycleRouteParser } from "@/lib/terminal/lifecycle-parse-client";
import { resolveJoinToken, type JoinTokenResult, type RegistryAsset } from "@/lib/terminal/lifecycle-resolve";
import { isHiddenAsset } from "@/lib/arena-read/hidden-assets";

const EXAMPLES = [
  "join battle 7 with CASHCAT",
  "deposit 250 ke battle 7 komunitas 2",
  "create price gain battle in 15 minutes",
  "cancel battle 7",
  "refund battle 7 komunitas 2",
];

export const PAYOUT_BLOCKED_REASON =
  "Payout requests are currently unavailable. Nothing was sent.";

const CREDIT_TEXT: Record<CreditState, string> = {
  credited: "Credited: the arena reports this amount on your position.",
  partial: "Partly credited: the arena reports less than the amount you sent. The rest was refunded or is still in flight.",
  not_credited: "Not credited: the arena reports no change to your position. The transfer may have been refunded.",
  unknown: "Credit could not be read yet. The transaction is not a credited position until the arena reports it.",
};

type Position = { registered: boolean; amount: string } | null;

/**
 * The reviewed call for one intent: preview, canonical comparison, authorization and wallet signing through the same
 * flow as the other lifecycle pages. Nothing contacts the action service until the user presses the preview button.
 * `trackCredit` (deposits) reads the position around the transaction; a receipt is never taken as credit.
 */
function ReviewedCall({
  namespace,
  review,
  request,
  trackCredit,
}: {
  namespace: Namespace;
  review: CallReview;
  request: Record<string, unknown>;
  trackCredit: boolean;
}) {
  const { signIn } = useWallet();
  const run = useLifecycleCreate(request, review, applicationKey(namespace));
  const { flow } = run;
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [baselineFor, setBaselineFor] = useState<string | null>(null);
  const seen = useRef<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (flow.step === "previewed" && trackCredit && seen.current !== flow.previewed.record.actionId) {
      const id = flow.previewed.record.actionId;
      seen.current = id;
      void run.readPosition(id).then((p: Position) => {
        if (seen.current !== id) return;
        setBefore(p ? p.amount : null);
        setBaselineFor(id);
      });
    }
    if (flow.step === "done" && trackCredit && flow.result.ok && flow.result.actionId) {
      const id = flow.result.actionId;
      void run.readPosition(id).then((p: Position) => setAfter(p ? p.amount : null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  const credit = creditOutcome(before, after, trackCredit && request.kind === "deposit" ? String(request.amount) : "1");
  const waitingBaseline = trackCredit && flow.step === "previewed" && baselineFor !== flow.previewed.record.actionId;
  return (
    <div className="space-y-3" aria-label="Reviewed call">
      <dl className="grid gap-1 text-xs sm:grid-cols-[12rem_1fr]">
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
      </ul>
      <details className="lifecycle-tech">
        <summary>Exact transaction arguments</summary>
        <pre aria-label="Exact arguments" className="mt-3 max-h-64 overflow-auto rounded-lg border border-edge p-3 text-xs">
          {JSON.stringify(review.args, null, 2)}
        </pre>
      </details>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          onClick={async () => {
            await navigator.clipboard?.writeText(JSON.stringify(review.args));
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy exact arguments"}
        </Button>
        {run.connected ? (
          <Button type="button" onClick={run.preview} disabled={flow.step === "previewing" || flow.step === "signing"}>
            {flow.step === "previewing" ? "Checking your review…" : "Check transaction preview"}
          </Button>
        ) : (
          <Button type="button" variant="ghost" onClick={() => void signIn()}>
            Connect wallet to sign
          </Button>
        )}
      </div>
      {!run.connected && (
        <p className="text-xs text-mute">
          Signing needs a connected wallet on a deployment that enables it (NEXT_PUBLIC_APPLICATION_WALLET). Without one the terminal stays review-only and nothing is sent.
        </p>
      )}
      {flow.step === "blocked" && (
        <ul role="alert" className="list-disc pl-4 text-xs text-neon-red">
          <li>Stopped before any authorization: the service&apos;s preview is not the call you reviewed.</li>
          {flow.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {flow.step === "previewed" && (
        <div role="status" className="space-y-2">
          <p className="text-xs text-neon-green">Your request is ready to review in your wallet. Nothing has been signed yet.</p>
          <p className="break-all text-xs text-mute">Preview {flow.previewed.record.previewHash}</p>
          <Button type="button" onClick={run.execute} disabled={waitingBaseline}>
            {waitingBaseline ? "Reading your current position…" : "Authorize and sign with wallet"}
          </Button>
          <p className="text-xs text-mute">Your wallet will ask you to approve this exact preview, then to sign the transaction.</p>
        </div>
      )}
      {flow.step === "signing" && (
        <p role="status" className="text-xs text-mute">
          Waiting for the wallet and the verified receipt…
        </p>
      )}
      {flow.step === "done" && (
        <p role={flow.result.ok ? "status" : "alert"} className={flow.result.ok ? "text-xs text-neon-green" : "text-xs text-neon-amber"}>
          {flow.result.ok
            ? `Receipt verified. Transaction ${flow.result.txHash}.`
            : `Not confirmed (${flow.result.status}): ${flow.result.reason}${flow.result.txHash ? ` Transaction ${flow.result.txHash} was submitted; it has no effect until the receipt is verified.` : ""}`}
          {flow.result.ok && flow.result.fixture ? ` ${flow.result.fixture}` : ""}
          <TransactionLink hash={flow.result.txHash} />
        </p>
      )}
      {flow.step === "error" && (
        <p role="alert" className="text-xs text-neon-red">
          {flow.message}{" "}
          <button type="button" className="underline" onClick={run.reset}>
            Try again
          </button>
        </p>
      )}
      {trackCredit && (before !== null || after !== null) && (
        <p role="status" className="text-xs">
          <Badge tone={credit.state === "credited" ? "green" : "amber"}>{credit.state.replace("_", " ")}</Badge> {CREDIT_TEXT[credit.state]}
          {credit.state !== "unknown" ? ` Change on your position: ${credit.delta} units.` : ""}
        </p>
      )}
    </div>
  );
}

function Problems({ problems }: { problems: string[] }) {
  return (
    <ul role="status" className="list-disc pl-4 text-sm text-neon-amber">
      {problems.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

/** Reads the intent's battle once so the review uses the recorded community representation, never prompt text. */
function useBattle(namespace: Namespace, battleId: number) {
  const [state, setState] = useState<{ detail: LifecycleDetail | null; error: string | null; loading: boolean }>({ detail: null, error: null, loading: true });
  useEffect(() => {
    const ctl = new AbortController();
    setState({ detail: null, error: null, loading: true });
    fetchLifecycleBattle(namespace, String(battleId), ctl.signal)
      .then((env) => setState({ detail: env.data, error: null, loading: false }))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setState({ detail: null, error: e instanceof Error ? e.message : String(e), loading: false });
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationKey(namespace), battleId]);
  return state;
}

function ParticipationPlan({ namespace, intent }: { namespace: Namespace; intent: Extract<LifecycleIntent, { kind: "register_position" | "deposit" }> }) {
  const { detail, error, loading } = useBattle(namespace, intent.battleId);
  const rows = useMemo(() => (detail ? communityRows(detail, 0) : []), [detail]);
  const status = detail ? battleStatus(detail) : null;
  const request = useMemo(() => intentToRequest(intent), [intent]);
  const row = rows[intent.community];
  const review: Review | null = useMemo(() => {
    if (!detail) return null;
    if (intent.kind === "register_position") return buildRegisterReview(namespace.arenaContract, intent.battleId, intent.community);
    return buildDepositReview({
      arena: namespace.arenaContract,
      representation: row?.representation ?? "",
      battleId: intent.battleId,
      community: intent.community,
      amount: intent.amount,
    });
  }, [detail, intent, namespace.arenaContract, row?.representation]);

  if (loading) return <p role="status" className="text-xs text-mute">Reading battle #{intent.battleId}…</p>;
  if (error || !detail) return <p role="alert" className="text-xs text-neon-red">Battle #{intent.battleId} could not be read: {error}. No review was built.</p>;
  if (!row) return <Problems problems={[`Battle #${intent.battleId} has ${rows.length} communities; community ${intent.community + 1} does not exist.`]} />;
  if (status !== "open") return <Problems problems={[`Battle #${intent.battleId} is ${status}: positions can no longer be registered and a deposit would be returned.`]} />;
  if (!review || !request) return null;
  if (!review.ok) return <Problems problems={review.problems} />;
  return <ReviewedCall namespace={namespace} review={review} request={request} trackCredit={intent.kind === "deposit"} />;
}

async function searchAssets(namespace: Namespace, q: string): Promise<RegistryAsset[]> {
  const res = await fetchApplication<ApplicationPage<RegistryAsset>>(namespace, "assets", { q, limit: 8 }, new AbortController().signal);
  return res.data.items.filter((a) => !isHiddenAsset(a)); // AI is no longer offered (D35)
}

/**
 * Create an open arena (D34). The exact start time is fixed once, when this plan first renders, so the reviewed
 * call does not drift with the clock; reading the request again fixes a new one.
 */
function CreatePlan({ namespace, intent }: { namespace: Namespace; intent: Extract<LifecycleIntent, { kind: "create_battle" }> }) {
  const [startAtMs] = useState(() => String(Date.now() + intent.startInMinutes * 60_000));
  const now = useNow(1000);
  const review = now > 0 ? buildCreateReview(namespace.arenaContract, [], intent.mode, startAtMs, now, config.createModes) : null;
  const request = useMemo(() => intentToRequest(intent, { startAtMs }), [intent, startAtMs]);
  if (!review || !request) return null;
  if (!review.ok) return <Problems problems={[...review.problems, "Read the request again to fix a new start time."]} />;
  return <ReviewedCall namespace={namespace} review={review} request={request} trackCredit={false} />;
}

/** Join with a token: the representation always comes from the arena's allowlist, never from the prompt. */
function JoinPlan({ namespace, intent }: { namespace: Namespace; intent: Extract<LifecycleIntent, { kind: "join_battle" }> }) {
  const { detail, error, loading } = useBattle(namespace, intent.battleId);
  const joinable = useJoinableAssets(namespace.arenaContract);
  const [resolved, setResolved] = useState<JoinTokenResult | null>(null);
  const now = useNow(1000);
  useEffect(() => {
    if (!joinable.items) return;
    let live = true;
    setResolved(null);
    void resolveJoinToken(intent.tokenRef, joinable.items, (q) => searchAssets(namespace, q)).then((r) => live && setResolved(r));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent, joinable.items, applicationKey(namespace)]);
  const representation = resolved?.ok ? resolved.representation : undefined;
  const request = useMemo(() => intentToRequest(intent, { representation }), [intent, representation]);
  const review = useMemo(
    () => (resolved?.ok ? buildJoinReview(namespace.arenaContract, intent.battleId, resolved.representation, resolved.symbol ?? undefined) : null),
    [resolved, namespace.arenaContract, intent.battleId],
  );

  if (loading || (!joinable.items && !joinable.error) || (joinable.items && !resolved)) {
    return <p role="status" className="text-xs text-mute">Reading battle #{intent.battleId} and the joinable tokens…</p>;
  }
  if (error || !detail) return <p role="alert" className="text-xs text-neon-red">Battle #{intent.battleId} could not be read: {error}. No review was built.</p>;
  if (joinable.error) return <p role="alert" className="text-xs text-neon-red">The joinable-token allowlist could not be read: {joinable.error}. No review was built.</p>;
  if (resolved && !resolved.ok) return <p role="alert" className="text-sm text-neon-amber">{resolved.question}</p>;
  const phase = openPhase(detail, now);
  if (phase.kind !== "gathering") return <Problems problems={[`Battle #${intent.battleId} is not open for joining: ${PHASE_REASON[phase.kind]}.`]} />;
  if (!review || !request) return null;
  if (!review.ok) return <Problems problems={review.problems} />;
  return <ReviewedCall namespace={namespace} review={review} request={request} trackCredit={false} />;
}

const PHASE_REASON: Record<ReturnType<typeof openPhase>["kind"], string> = {
  no_start: "it has no start time, so communities cannot join it",
  gathering: "it is open",
  awaiting_lock: "the start time has passed with at least two funded communities",
  cancellable: "the start time has passed",
  cancelled: "it was cancelled",
  locked: "it is locked",
};

function CancelPlan({ namespace, intent }: { namespace: Namespace; intent: Extract<LifecycleIntent, { kind: "cancel_battle" }> }) {
  const { detail, error, loading } = useBattle(namespace, intent.battleId);
  const now = useNow(1000);
  const request = useMemo(() => intentToRequest(intent), [intent]);
  const review = useMemo(() => buildCancelReview(namespace.arenaContract, intent.battleId), [namespace.arenaContract, intent.battleId]);
  if (loading) return <p role="status" className="text-xs text-mute">Reading battle #{intent.battleId}…</p>;
  if (error || !detail) return <p role="alert" className="text-xs text-neon-red">Battle #{intent.battleId} could not be read: {error}. No review was built.</p>;
  const phase = openPhase(detail, now);
  if (phase.kind !== "cancellable") {
    return <Problems problems={[`Battle #${intent.battleId} cannot be cancelled: ${phase.kind === "gathering" ? "the start time has not passed" : PHASE_REASON[phase.kind]}.`]} />;
  }
  if (!request) return null;
  if (!review.ok) return <Problems problems={review.problems} />;
  return <ReviewedCall namespace={namespace} review={review} request={request} trackCredit={false} />;
}

function RefundPlan({ namespace, intent }: { namespace: Namespace; intent: Extract<LifecycleIntent, { kind: "claim_refund" }> }) {
  const { detail, error, loading } = useBattle(namespace, intent.battleId);
  const request = useMemo(() => intentToRequest(intent), [intent]);
  const review = useMemo(() => buildRefundReview(namespace.arenaContract, intent.battleId, intent.community), [namespace.arenaContract, intent.battleId, intent.community]);
  if (loading) return <p role="status" className="text-xs text-mute">Reading battle #{intent.battleId}…</p>;
  if (error || !detail) return <p role="alert" className="text-xs text-neon-red">Battle #{intent.battleId} could not be read: {error}. No review was built.</p>;
  if (detail.battle.cancelled !== true) return <Problems problems={[`Battle #${intent.battleId} is not cancelled: only a cancelled battle refunds deposits.`]} />;
  if (!detail.battle.communities[intent.community]) return <Problems problems={[`Battle #${intent.battleId} has ${detail.battle.communities.length} communities; community ${intent.community + 1} does not exist.`]} />;
  if (!request) return null;
  if (!review.ok) return <Problems problems={review.problems} />;
  return <ReviewedCall namespace={namespace} review={review} request={request} trackCredit={false} />;
}

function PayoutPlan({ intent }: { intent: Extract<LifecycleIntent, { kind: "payout" }> }) {
  return (
    <div className="space-y-3" aria-label="Reviewed call">
      <dl className="grid gap-1 text-xs sm:grid-cols-[12rem_1fr]">
        {[
          ["Action", "request_payout"],
          ["Backing token", intent.backing],
          ["Amount", `${intent.amount} base units`],
          ["Destination (Robinhood)", intent.destination],
        ].map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-mute">{k}</dt>
            <dd className="break-all">{v}</dd>
          </div>
        ))}
      </dl>
      <Button type="button" disabled aria-describedby="payout-blocked">
        Payout cannot be submitted yet
      </Button>
      <p id="payout-blocked" role="status" className="text-xs text-neon-amber">
        {PAYOUT_BLOCKED_REASON}
      </p>
    </div>
  );
}

/**
 * Lifecycle intent terminal. A prompt is parsed (rules, or the optional server-side model) into one validated intent;
 * the intent is shown, turned into the same reviewed call the other lifecycle pages use, and only the user pressing
 * "Check transaction preview" contacts the action service. Free text and model output never reach signing.
 */
export function LifecycleTerminal({ namespace }: { namespace: Namespace }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LifecycleParseResult | null>(null);
  const [runId, setRunId] = useState(0);
  const parser = useMemo(() => createLifecycleRouteParser(), []);

  async function submit() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    const r = await parser.parse(prompt);
    setResult(r);
    setRunId((n) => n + 1);
    setBusy(false);
  }
  const intent = result?.ok ? result.intent : null;
  return (
    <div className="space-y-6">
      <Card>
        <CardTitle>01 / Say what you want</CardTitle>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-3"
        >
          <Label>
            Your request (English or Bahasa Indonesia)
            <textarea
              aria-label="Terminal prompt"
              value={prompt}
              maxLength={MAX_PROMPT_CHARS}
              rows={3}
              onChange={(e) => setPrompt(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-edge bg-transparent p-2 text-sm"
              placeholder={EXAMPLES[0]}
            />
          </Label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy || !prompt.trim()}>
              {busy ? "Reading…" : "Read my request"}
            </Button>
            {EXAMPLES.slice(0, 2).map((ex) => (
              <button key={ex} type="button" className="text-xs underline text-mute" onClick={() => setPrompt(ex)}>
                {ex}
              </button>
            ))}
          </div>
          <p className="text-xs text-mute">
            Reading a request sends nothing to your wallet or the action service. Communities are numbered from 1; amounts are exact whole numbers in token base units; a join only uses tokens on the arena&apos;s joinable allowlist.
          </p>
        </form>
      </Card>

      {result && !result.ok && (
        <Card role="status" aria-label="Clarification">
          <CardTitle>{result.clarify ? "One more thing" : "Could not read that"}</CardTitle>
          <p className="text-sm">{result.error}</p>
        </Card>
      )}

      {intent && (
        <Card aria-label="Understood request" key={runId}>
          <CardTitle>02 / What I understood</CardTitle>
          <p className="mb-1 text-sm" data-testid="intent-summary">
            {describeIntent(intent)}
            {intent.kind === "create_battle" ? ` · ${MODE_COPY[intent.mode].name}` : ""}
          </p>
          <p className="mb-4 text-xs text-mute">This is a reading of your words, not an approval. Review the exact call below before anything is checked or signed.</p>
          <p className="eyebrow mb-3 text-neon-green">03 / REVIEW BEFORE YOU SIGN</p>
          {intent.kind === "payout" ? (
            <PayoutPlan intent={intent} />
          ) : intent.kind === "create_battle" ? (
            <CreatePlan namespace={namespace} intent={intent} />
          ) : intent.kind === "join_battle" ? (
            <JoinPlan namespace={namespace} intent={intent} />
          ) : intent.kind === "cancel_battle" ? (
            <CancelPlan namespace={namespace} intent={intent} />
          ) : intent.kind === "claim_refund" ? (
            <RefundPlan namespace={namespace} intent={intent} />
          ) : (
            <ParticipationPlan namespace={namespace} intent={intent} />
          )}
        </Card>
      )}
    </div>
  );
}
