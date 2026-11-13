"use client";
import { TransactionLink } from "@/components/transaction-link";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useLifecycleCreate } from "@/hooks/use-lifecycle-create";
import { usePortfolio } from "@/hooks/use-portfolio";
import { useJoinableAssets } from "@/hooks/use-joinable-assets";
import { plainSymbol } from "@/lib/arena-read/token-name";
import { useAction } from "@/hooks/use-action";
import { useActionRunner } from "@/hooks/use-action-runner";
import { buildVoteReview, daoStep, readDisposition, voteMsLeft, voteRequest, type Disposition } from "@/lib/arena-read/dao";
import { readMyPositions } from "@/lib/arena-read/positions";
import {
  buildClaimReview,
  buildRegisterReview as buildTokenRegisterReview,
  claimRequest,
  readRegistered as readTokenRegistered,
  registerRequest as tokenRegisterRequest,
} from "@/lib/arena-read/claim";
import { config } from "@/lib/config";
import { loadPlans, removePlan, savePlan, type SavedVote } from "@/lib/terminal/saved-plans";
import { useBalances } from "@/hooks/use-balances";
import { JOIN_STAGE_TEXT, useJoinAndDeposit } from "@/hooks/use-join-and-deposit";
import { firstDepositProblems } from "@/lib/arena-read/create-deposit";
import { useNow } from "@/hooks/use-now";
import { formatUnits } from "@/lib/amounts";
import { applicationKey, fetchApplication, type ApplicationBattlePage, type ApplicationPage, type Namespace } from "@/lib/arena-read/application";
import type { CallReview } from "@/lib/arena-read/create-review";
import { buildCancelReview, buildJoinReview, buildRefundReview, openPhase } from "@/lib/arena-read/open-arena";
import {
  buildDepositReview,
  buildRegisterReview,
  creditOutcome,
  type CreditState,
  type Review,
} from "@/lib/arena-read/deposit-flow";
import { battleStatus, communityRows, fetchLifecycleBattle, type LifecycleDetail } from "@/lib/arena-read/lifecycle";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import { MODE_COPY } from "@/lib/arena-read/lifecycle-presentation";
import {
  MAX_PROMPT_CHARS,
  describeIntent,
  intentToRequest,
  type LifecycleIntent,
  type LifecycleParseResult,
} from "@/lib/terminal/lifecycle-intent";
import { chooseArena, openArenasOf, type OpenArena } from "@/lib/terminal/lifecycle-open";
import { answer, ask, emptyChat, followUp, isInteractive, isThinking, type Chat, type Turn } from "@/lib/terminal/chat";
import { createLifecycleRouteParser } from "@/lib/terminal/lifecycle-parse-client";
import { resolveJoinToken, type JoinTokenResult, type RegistryAsset } from "@/lib/terminal/lifecycle-resolve";
import { isHiddenAsset } from "@/lib/arena-read/hidden-assets";

const EXAMPLES = [
  "deposit 100 CASHCAT into the open arena",
  "which arenas are open?",
  "join the open arena with CASHCAT",
  "my positions",
  "create price gain battle in 15 minutes",
  "cancel battle 7",
  "claim my winnings",
  "vote burn 50% battle 7",
  "deposit 2 CASHCAT and 2 VLAD in the open arena, then vote burn 50% on that battle if I win",
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
      <details className="lifecycle-tech">
        <summary>Details</summary>
        <dl className="mt-3 grid gap-1 text-xs sm:grid-cols-[12rem_1fr]">
          {review.lines.map((l) => (
            <div key={l.label} className="contents">
              <dt className="text-mute">{l.label}</dt>
              <dd className="break-all">{l.value}</dd>
            </div>
          ))}
        </dl>
        <pre aria-label="Exact arguments" className="mt-3 max-h-64 overflow-auto rounded-lg border border-edge p-3 text-xs">
          {JSON.stringify(review.args, null, 2)}
        </pre>
      </details>
      <div className="flex flex-wrap items-center gap-3">
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
          Signing needs a connected wallet on a deployment that enables it (NEXT_PUBLIC_APPLICATION_WALLET). Without one the assistant stays review-only and nothing is sent.
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

type Known<K extends LifecycleIntent["kind"]> = Omit<Extract<LifecycleIntent, { kind: K }>, "battleId"> & { battleId: number };
type Replace = (next: LifecycleIntent) => void;

/**
 * Deposit by token: one button does what the manual deposit does. It adds the token as a community and registers the
 * account when the battle does not have it yet, waits for the approvals, then deposits. The representation comes from
 * the arena's allowlist, never from the prompt, and every step is previewed and compared before the wallet is asked.
 */
function JoinDepositPlan({ namespace, intent, onDone }: { namespace: Namespace; intent: Known<"deposit"> & { tokenRef: string }; onDone?: () => void }) {
  const { signIn } = useWallet();
  const { detail, error, loading } = useBattle(namespace, intent.battleId);
  const joinable = useJoinableAssets(namespace.arenaContract);
  const { balances } = useBalances();
  const flow = useJoinAndDeposit(namespace.arenaContract, intent.battleId);
  const [resolved, setResolved] = useState<JoinTokenResult | null>(null);
  const now = useNow(1000);
  const finished = useRef(false);
  const deposited = flow.state.step === "done";
  useEffect(() => {
    if (deposited && !finished.current) {
      finished.current = true;
      onDone?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deposited]);
  useEffect(() => {
    if (!joinable.items) return;
    let live = true;
    setResolved(null);
    void resolveJoinToken(intent.tokenRef, joinable.items, (q) => searchAssets(namespace, q)).then((r) => live && setResolved(r));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent.tokenRef, joinable.items, applicationKey(namespace)]);

  if (loading || (!joinable.items && !joinable.error) || (joinable.items && !resolved)) {
    return <p role="status" className="text-xs text-mute">Reading battle #{intent.battleId} and the joinable tokens…</p>;
  }
  if (error || !detail) return <p role="alert" className="text-xs text-neon-red">Battle #{intent.battleId} could not be read: {error}. No review was built.</p>;
  if (joinable.error) return <p role="alert" className="text-xs text-neon-red">The joinable-token allowlist could not be read: {joinable.error}. Nothing was prepared.</p>;
  if (resolved && !resolved.ok) return <p role="alert" className="text-sm text-neon-amber">{resolved.question}</p>;
  if (!resolved || !resolved.ok) return null;
  const phase = openPhase(detail, now);
  if (phase.kind !== "gathering") return <Problems problems={[`Battle #${intent.battleId} is not open for deposits: ${PHASE_REASON[phase.kind]}.`]} />;

  const symbol = plainSymbol(resolved.symbol ?? intent.tokenRef);
  const held = balances?.tokens.find((t) => t.token === resolved.representation)?.balance ?? null;
  const problems = firstDepositProblems(resolved.representation, intent.amount, held);
  const st = flow.state;
  const label = `${formatUnits(BigInt(intent.amount), TOKEN_DECIMALS, 4)} ${symbol}`;
  return (
    <div className="space-y-3" aria-label="Deposit">
      {st.step === "done" ? null : flow.connected ? (
        <Button type="button" className="min-w-48" disabled={problems.length > 0 || st.step === "running"} onClick={() => void flow.run(resolved.representation, symbol, intent.amount)}>
          {st.step === "failed" ? "Continue" : `Deposit ${label}`}
        </Button>
      ) : (
        <Button type="button" variant="ghost" onClick={() => void signIn()}>
          Connect wallet to deposit
        </Button>
      )}
      {st.step !== "done" && <p className="text-xs text-mute">If {symbol} is not in battle #{intent.battleId} yet, it is added automatically before the deposit. Your wallet asks you to confirm each step.</p>}
      {/* Messages sit below the button and share one reserved area, so the button never moves when they change. */}
      <div className="min-h-[3.5rem] space-y-1">
        {st.step !== "done" && problems.length > 0 && st.step !== "running" && (
          <ul role="status" className="list-disc pl-4 text-xs text-neon-amber">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {st.step === "running" && (
          <p role="status" className="text-xs text-mute">
            {JOIN_STAGE_TEXT[st.stage]} Confirm in your wallet when asked.
          </p>
        )}
        {st.step === "failed" && (
          <p role="alert" className="text-xs text-neon-amber">
            Deposit failed: {st.message}
          </p>
        )}
        {st.step === "done" && (
          <p role="status" className="text-xs text-neon-green">
            Deposited {label} into battle #{intent.battleId}.
          </p>
        )}
      </div>
      {flow.txHashes.length > 0 && (
        <div className="space-y-1">
          {flow.txHashes.map((hash, i) => (
            <div key={hash} className="text-xs">
              <span>Transaction {i + 1}</span>
              <TransactionLink hash={hash} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ParticipationPlan({
  namespace,
  intent,
  onReplace,
}: {
  namespace: Namespace;
  intent: Known<"register_position"> | Known<"deposit">;
  onReplace: Replace;
}) {
  if (intent.kind === "deposit" && intent.community === null && intent.tokenRef !== null) {
    return <JoinDepositPlan namespace={namespace} intent={{ ...intent, tokenRef: intent.tokenRef }} />;
  }
  return <CommunityPlan namespace={namespace} intent={intent} onReplace={onReplace} />;
}

function CommunityPlan({
  namespace,
  intent,
  onReplace,
}: {
  namespace: Namespace;
  intent: Known<"register_position"> | Known<"deposit">;
  onReplace: Replace;
}) {
  const { detail, error, loading } = useBattle(namespace, intent.battleId);
  const rows = useMemo(() => (detail ? communityRows(detail, 0) : []), [detail]);
  const status = detail ? battleStatus(detail) : null;
  const community: number | null = intent.community;
  const concrete = useMemo(() => (community === null ? null : { ...intent, community }), [intent, community]);
  const request = useMemo(() => (concrete ? intentToRequest(concrete) : null), [concrete]);
  const row = community === null ? undefined : rows[community];
  const review: Review | null = useMemo(() => {
    if (!detail || community === null) return null;
    if (intent.kind === "register_position") return buildRegisterReview(namespace.arenaContract, intent.battleId, community);
    return buildDepositReview({
      arena: namespace.arenaContract,
      representation: row?.representation ?? "",
      battleId: intent.battleId,
      community,
      amount: intent.amount,
    });
  }, [detail, intent, community, namespace.arenaContract, row?.representation]);

  if (loading) return <p role="status" className="text-xs text-mute">Reading battle #{intent.battleId}…</p>;
  if (error || !detail) return <p role="alert" className="text-xs text-neon-red">Battle #{intent.battleId} could not be read: {error}. No review was built.</p>;
  if (community === null || !row) return <Problems problems={[`Battle #${intent.battleId} has ${rows.length} communities; that community does not exist.`]} />;
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
 * Create a battle (D41): a battle exists only with its creator's deposit (a token and an amount), which a prompt
 * does not carry, so the terminal sends the user to the create page instead of building a call.
 */
function CreatePlan({ intent }: { intent: Extract<LifecycleIntent, { kind: "create_battle" }> }) {
  return (
    <p className="text-sm leading-7" role="status">
      A battle is created together with your first deposit, so it is made on the{" "}
      <Link href="/arena/new" className="underline">create page</Link>, where you pick the token and the amount.
      Your challenge ({intent.mode}) and start time can be set there.
    </p>
  );
}

/** Join with a token: the representation always comes from the arena's allowlist, never from the prompt. */
function JoinPlan({ namespace, intent }: { namespace: Namespace; intent: Known<"join_battle"> }) {
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

/** The prize into the connected NEAR wallet: one button per claimable token, the same call as the battle page. */
function ClaimPlan() {
  const portfolio = usePortfolio();
  const { act, accountId, connected } = useActionRunner();
  const action = useAction();
  const { signIn } = useWallet();
  const [claimed, setClaimed] = useState<string[]>([]);
  const ready = portfolio.state.step === "ready" ? portfolio.state.data : null;
  const claimable = useMemo(() => {
    if (!ready || ready.accountState.state !== "ok") return null;
    return ready.accountState.env.data.entitlements
      .filter((e) => /^[0-9]+$/.test(e.available) && BigInt(e.available) > 0n && !claimed.includes(e.backing))
      .map((e) => ({ backing: e.backing, available: e.available }));
  }, [ready, claimed]);
  const reading = portfolio.state.step === "reading";

  const claim = (e: { backing: string; available: string }) =>
    action.run(async () => {
      if (!accountId) throw new Error("connect a wallet first");
      const label = symbolOf(e.backing);
      if (!(await readTokenRegistered(config.rpcUrl, e.backing, accountId))) {
        const register = buildTokenRegisterReview(e.backing, accountId, label);
        await act(tokenRegisterRequest(e.backing), register.ok ? register : null);
      }
      const review = buildClaimReview(e.backing, e.available, label);
      await act(claimRequest(e.backing, e.available), review.ok ? review : null);
      setClaimed((c) => [...c, e.backing]);
    });

  if (!connected || !accountId) {
    return (
      <div className="space-y-2" role="status">
        <p className="text-sm">Connect your wallet to see your winnings.</p>
        <Button type="button" variant="ghost" onClick={() => void signIn()}>Connect wallet</Button>
      </div>
    );
  }
  return (
    <div className="space-y-3" aria-label="Claim winnings">
      {!ready && (
        <Button type="button" className="min-w-48" disabled={reading} onClick={() => void portfolio.load()}>
          {reading ? "Checking your winnings…" : "Check my winnings"}
        </Button>
      )}
      {claimable?.map((e) => (
        <Button key={e.backing} type="button" className="min-w-48" disabled={action.busy} onClick={() => void claim(e)}>
          {action.busy ? "Claiming…" : `Claim ${formatUnits(BigInt(e.available), TOKEN_DECIMALS, 4)} ${symbolOf(e.backing)}`}
        </Button>
      ))}
      <div className="min-h-[1.5rem] space-y-1">
        {claimable?.length === 0 && (
          <p role="status" className={claimed.length > 0 ? "text-xs text-neon-green" : "text-sm text-mute"}>
            {claimed.length > 0 ? "Claimed. The tokens are in your NEAR wallet." : "No winnings to claim yet. They appear after a battle is settled."}
          </p>
        )}
        {action.error && <p role="alert" className="text-xs text-neon-red">{action.error}</p>}
        {portfolio.state.step === "error" && <p role="alert" className="text-xs text-neon-red">{portfolio.state.message}</p>}
      </div>
    </div>
  );
}

/** The winners' vote on their principal. Only the winning token's depositors can vote, once. */
function DaoVotePlan({ namespace, battleId, burnPercent, onDone }: { namespace: Namespace; battleId: number; burnPercent: number; onDone?: () => void }) {
  const intent = { battleId, burnPercent };
  const { detail, error, loading } = useBattle(namespace, intent.battleId);
  const { act, accountId, connected } = useActionRunner();
  const { signIn } = useWallet();
  const action = useAction();
  const now = useNow(1000);
  const [view, setView] = useState<Disposition | null>(null);
  const [weight, setWeight] = useState<bigint | null>(null);
  const [voted, setVoted] = useState(false);
  const rows = useMemo(() => (detail ? communityRows(detail, 0) : []), [detail]);
  const winner = detail?.round?.winner ?? null;
  const count = detail?.battle.communities.length ?? 0;
  const token = winner !== null ? plainSymbol(rows[winner]?.label?.symbol ?? "the winning token") : "the winning token";

  useEffect(() => {
    if (winner === null) return;
    let live = true;
    void Promise.all([
      readDisposition(config.rpcUrl, namespace.arenaContract, intent.battleId),
      accountId ? readMyPositions(config.rpcUrl, namespace.arenaContract, intent.battleId, accountId, count) : Promise.resolve([]),
    ])
      .then(([d, positions]) => {
        if (!live) return;
        setView(d);
        setWeight(BigInt(positions.find((p) => p.community === winner)?.amount ?? "0"));
      })
      .catch(() => live && setView(null));
    return () => {
      live = false;
    };
  }, [winner, count, accountId, intent.battleId, namespace.arenaContract]);

  if (loading) return <p role="status" className="text-xs text-mute">Reading battle #{intent.battleId}…</p>;
  if (error || !detail) return <p role="alert" className="text-xs text-neon-red">Battle #{intent.battleId} could not be read: {error}. Nothing was prepared.</p>;
  if (winner === null) return <Problems problems={[`Battle #${intent.battleId} has no final winner yet, so there is nothing to vote on.`]} />;
  if (!view) return <p role="status" className="text-xs text-mute">Reading the vote…</p>;
  const step = daoStep(view);
  if (step.kind !== "voting" || voteMsLeft(view, now) <= 0) {
    return <Problems problems={[step.kind === "none" ? step.reason : "Voting is not open for this battle."]} />;
  }
  if (!connected || !accountId) {
    return (
      <div className="space-y-2" role="status">
        <p className="text-sm">Connect your wallet to vote.</p>
        <Button type="button" variant="ghost" onClick={() => void signIn()}>Connect wallet</Button>
      </div>
    );
  }
  if (weight === null) return <p role="status" className="text-xs text-mute">Reading your position…</p>;
  if (weight === 0n) return <Problems problems={[`Only people who deposited in ${token} can vote.`]} />;

  const weightLabel = `${formatUnits(weight, TOKEN_DECIMALS, 4)} ${token}`;
  const vote = () =>
    action.run(async () => {
      const review = buildVoteReview(namespace.arenaContract, intent.battleId, intent.burnPercent, weightLabel);
      await act(voteRequest(intent.battleId, intent.burnPercent), review.ok ? review : null);
      setVoted(true);
      onDone?.();
    });
  return (
    <div className="space-y-3" aria-label="DAO vote">
      <p className="text-xs text-mute">Your weight: {weightLabel}. One vote per account, and it is final.</p>
      {!voted && (
        <Button type="button" className="min-w-48" disabled={action.busy} onClick={() => void vote()}>
          {action.busy ? "Voting…" : `Vote: ${intent.burnPercent}% burn, ${100 - intent.burnPercent}% return`}
        </Button>
      )}
      <div className="min-h-[1.5rem]">
        {voted && <p role="status" className="text-xs text-neon-green">Your vote is cast.</p>}
        {action.error && <p role="alert" className="text-xs text-neon-red">{action.error}</p>}
      </div>
    </div>
  );
}

const symbolOf = (representation: string): string => representation.replace(/^backing-/, "").split(".")[0]!.toUpperCase();

/** Reads the open arenas once (backend filter), keeping only the ones that still accept communities. */
function useOpenArenas(namespace: Namespace) {
  const [state, setState] = useState<{ arenas: OpenArena[] | null; error: string | null }>({ arenas: null, error: null });
  useEffect(() => {
    const ctl = new AbortController();
    setState({ arenas: null, error: null });
    fetchApplication<ApplicationBattlePage>(namespace, "battles", { status: "open", limit: 30 }, ctl.signal)
      .then((env) => setState({ arenas: openArenasOf(env.data.items, Date.now()), error: null }))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setState({ arenas: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationKey(namespace)]);
  return state;
}

function ArenaLine({ arena }: { arena: OpenArena }) {
  const mins = Math.max(0, Math.round((arena.startAtMs - Date.now()) / 60_000));
  return (
    <span>
      #{arena.battleId} · {arena.mode} · starts in {mins} min · {arena.symbols.length} communit{arena.symbols.length === 1 ? "y" : "ies"} ({arena.symbols.join(", ") || "none yet"})
    </span>
  );
}

/**
 * "An open arena": the terminal reads the open arenas and either uses the only one that fits (saying why) or shows the
 * list and waits for the user to pick. It never chooses among several, and nothing is signed here.
 */
function OpenArenaPlan({
  namespace,
  intent,
  onReplace,
}: {
  namespace: Namespace;
  intent: Extract<LifecycleIntent, { kind: "join_battle" | "register_position" | "deposit" }>;
  onReplace: Replace;
}) {
  const { arenas, error } = useOpenArenas(namespace);
  const [picked, setPicked] = useState<number | null>(null);
  const choice = useMemo(() => (arenas ? chooseArena(intent, arenas) : null), [arenas, intent]);
  if (error) return <p role="alert" className="text-xs text-neon-red">The open arenas could not be read: {error}. Nothing was prepared.</p>;
  if (!choice) return <p role="status" className="text-xs text-mute">Looking for open arenas…</p>;
  const use = (id: number) => ({ ...intent, battleId: id }) as Known<"join_battle"> & Known<"register_position"> & Known<"deposit">;
  const chosenId = picked ?? (choice.kind === "one" ? choice.arena.battleId : null);
  if (chosenId !== null) {
    const arena = arenas?.find((a) => a.battleId === chosenId);
    const why = picked !== null ? "you picked it" : choice.kind === "one" ? choice.why : "";
    const concrete = use(chosenId);
    return (
      <div className="space-y-3">
        <p role="status" className="text-xs text-mute">
          Using arena #{chosenId}{arena ? ` (${arena.mode})` : ""}: {why}.
        </p>
        {intent.kind === "join_battle" ? (
          <JoinPlan namespace={namespace} intent={concrete} />
        ) : (
          <ParticipationPlan namespace={namespace} intent={concrete} onReplace={onReplace} />
        )}
      </div>
    );
  }
  if (choice.kind === "none") {
    return (
      <div className="space-y-2" role="status">
        <p className="text-sm text-neon-amber">{choice.message}</p>
      </div>
    );
  }
  if (choice.kind !== "many") return null;
  return (
    <div className="space-y-2" role="status">
      <p className="text-sm">{choice.why}. Which one do you want?</p>
      <ul className="space-y-2">
        {choice.arenas.map((a) => (
          <li key={a.battleId} className="flex flex-wrap items-center gap-2 text-xs">
            <ArenaLine arena={a} />
            <Button type="button" variant="ghost" onClick={() => setPicked(a.battleId)}>
              Use #{a.battleId}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Which arenas are open?": a read-only list from the same backend list the Arena page uses. */
function ListBattlesPlan({ namespace, intent }: { namespace: Namespace; intent: Extract<LifecycleIntent, { kind: "list_battles" }> }) {
  const [state, setState] = useState<{ items: ApplicationBattlePage["items"] | null; error: string | null }>({ items: null, error: null });
  useEffect(() => {
    const ctl = new AbortController();
    setState({ items: null, error: null });
    fetchApplication<ApplicationBattlePage>(namespace, "battles", { ...(intent.status === "open" ? { status: "open" } : {}), limit: 12 }, ctl.signal)
      .then((env) => setState({ items: env.data.items, error: null }))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setState({ items: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationKey(namespace), intent.status]);
  if (state.error) return <p role="alert" className="text-xs text-neon-red">The arenas could not be read: {state.error}</p>;
  if (!state.items) return <p role="status" className="text-xs text-mute">Reading the arenas…</p>;
  const rows = intent.status === "open" ? openArenasOf(state.items, Date.now()) : null;
  if (rows && rows.length === 0) return <p role="status" className="text-sm">No arena is open right now.</p>;
  if (!rows && state.items.length === 0) return <p role="status" className="text-sm">There are no arenas yet.</p>;
  return (
    <ul className="space-y-2 text-sm" aria-label="Arenas">
      {(rows ?? state.items.map((b) => ({ battleId: Number(b.battleId), mode: b.mode, startAtMs: Number(b.startAtMs ?? 0), symbols: b.communities.map((c) => c.label?.symbol ?? "token"), status: b.status }))).map((a) => (
        <li key={a.battleId} className="flex flex-wrap items-center gap-2">
          <Link href={`/arena/${a.battleId}`} className="underline">
            Battle #{a.battleId}
          </Link>
          <span className="text-xs text-mute">
            {a.mode}
            {"status" in a ? ` · ${a.status}` : ""} · {a.symbols.length ? a.symbols.join(", ") : "no communities yet"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "My positions": the same public by-account read the Portfolio page uses. Read-only: it never prepares or signs an action. */
function PositionsPlan() {
  const { accountId, connected, state, load } = usePortfolio();
  const { signIn } = useWallet();
  if (!connected || !accountId) {
    return (
      <div className="space-y-2" role="status">
        <p className="text-sm">Connect your wallet to read your positions.</p>
        <Button type="button" variant="ghost" onClick={() => void signIn()}>Connect wallet</Button>
      </div>
    );
  }
  const positions = state.step === "ready" && state.data.positions.state === "ok" ? state.data.positions.env.data.positions : null;
  return (
    <div className="space-y-2">
      {state.step === "idle" || state.step === "error" ? (
        <Button type="button" onClick={() => void load()}>Read my positions</Button>
      ) : null}
      {(state.step === "reading") && <p role="status" className="text-xs text-mute">Reading your positions…</p>}
      {state.step === "error" && <p role="alert" className="text-xs text-neon-red">{state.message}</p>}
      {state.step === "ready" && state.data.positions.state === "error" && <p role="alert" className="text-xs text-neon-red">{state.data.positions.message}</p>}
      {positions && positions.length === 0 && <p className="text-sm">You have no positions yet.</p>}
      {positions && positions.length > 0 && (
        <ul className="space-y-1 text-sm" aria-label="Positions">
          {positions.map((p) => (
            <li key={`${p.battleId}:${p.community}`}>
              <Link href={`/arena/${p.battleId}`} className="underline">Battle #{p.battleId}</Link>, community {p.community + 1}:{" "}
              {/^[0-9]{1,60}$/.test(p.amount) ? formatUnits(BigInt(p.amount), 18, 4) : p.amount} {p.representation ? symbolOf(p.representation) : "tokens"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const browserStore = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** The deferred step of a prompt: a vote that can only happen once the battle is settled. It is saved, never run. */
function SaveVoteStep({ battleId, burnPercent, onDone }: { battleId: number; burnPercent: number; onDone: () => void }) {
  const { accountId, signIn } = useWallet();
  const saved = useRef(false);
  useEffect(() => {
    if (!accountId || saved.current) return;
    saved.current = true;
    savePlan(browserStore(), { account: accountId, battleId, burnPercent });
    onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);
  if (!accountId) {
    return (
      <div className="space-y-2" role="status">
        <p className="text-xs text-mute">Connect your wallet to save this vote for later.</p>
        <Button type="button" variant="ghost" onClick={() => void signIn()}>Connect wallet</Button>
      </div>
    );
  }
  return (
    <p role="status" className="text-xs text-neon-green">
      Saved in this browser. Once battle #{battleId} is settled and your token won, a vote button appears at the top of the Assistant.
    </p>
  );
}

type DepositIntent = Extract<LifecycleIntent, { kind: "deposit" }>;

/**
 * Several requests from one prompt, run in order: the open arena is chosen once for all of them, each deposit adds its
 * token first when needed, and the next step only opens after the one before it is done. A vote is saved for later.
 */
function MultiPlan({ namespace, intents }: { namespace: Namespace; intents: LifecycleIntent[] }) {
  const { arenas, error } = useOpenArenas(namespace);
  const [picked, setPicked] = useState<number | null>(null);
  const [done, setDone] = useState(0);
  const firstOpen = intents.find((i): i is DepositIntent => i.kind === "deposit" && i.battleId === null);
  const explicit = intents.flatMap((i) => (i.kind === "deposit" || i.kind === "dao_vote") && i.battleId !== null ? [i.battleId] : [])[0] ?? null;
  const choice = useMemo(() => (arenas && firstOpen ? chooseArena(firstOpen, arenas) : null), [arenas, firstOpen]);
  const shared = picked ?? (choice?.kind === "one" ? choice.arena.battleId : explicit);

  if (firstOpen && error) return <p role="alert" className="text-xs text-neon-red">The open arenas could not be read: {error}. Nothing was prepared.</p>;
  if (firstOpen && !choice && explicit === null) return <p role="status" className="text-xs text-mute">Looking for open arenas…</p>;
  if (shared === null) {
    if (choice?.kind === "none") return <p className="text-sm text-neon-amber" role="status">{choice.message}</p>;
    if (choice?.kind === "many") {
      return (
        <div className="space-y-2" role="status">
          <p className="text-sm">{choice.why}. Which one should all of these use?</p>
          <ul className="space-y-2">
            {choice.arenas.map((a) => (
              <li key={a.battleId} className="flex flex-wrap items-center gap-2 text-xs">
                <ArenaLine arena={a} />
                <Button type="button" variant="ghost" onClick={() => setPicked(a.battleId)}>Use #{a.battleId}</Button>
              </li>
            ))}
          </ul>
        </div>
      );
    }
    return <Problems problems={["Which battle? For example: battle 7."]} />;
  }
  const steps = intents.map((i) => (i.kind === "deposit" || i.kind === "dao_vote" ? { ...i, battleId: i.battleId ?? shared } : i));
  return (
    <ol className="space-y-4" aria-label="Steps">
      {steps.map((step, i) => (
        <li key={i} className="space-y-2">
          <p className={i < done ? "text-sm text-neon-green" : i === done ? "text-sm font-semibold" : "text-sm text-mute"}>
            {i < done ? "✓" : `${i + 1}.`} {describeIntent(step)}
          </p>
          {i === done && step.kind === "deposit" && step.tokenRef !== null && step.battleId !== null && (
            <JoinDepositPlan namespace={namespace} intent={{ ...step, battleId: step.battleId, tokenRef: step.tokenRef }} onDone={() => setDone((d) => Math.max(d, i + 1))} />
          )}
          {i === done && step.kind === "dao_vote" && step.battleId !== null && (
            <SaveVoteStep battleId={step.battleId} burnPercent={step.burnPercent} onDone={() => setDone((d) => Math.max(d, i + 1))} />
          )}
        </li>
      ))}
      {done >= steps.length && <p role="status" className="text-xs text-neon-green">All steps are done.</p>}
    </ol>
  );
}

/** Votes saved from an earlier prompt. Each one is the normal reviewed vote button; it removes itself once the vote is cast. */
function SavedPlans({ namespace }: { namespace: Namespace }) {
  const { accountId } = useWallet();
  const [plans, setPlans] = useState<SavedVote[]>([]);
  useEffect(() => setPlans(loadPlans(browserStore())), []);
  const mine = plans.filter((p) => p.account === accountId);
  if (mine.length === 0) return null;
  return (
    <Card className="space-y-4 p-4 sm:p-6" aria-label="Saved plans">
      <p className="eyebrow text-neon-green">SAVED PLANS</p>
      {mine.map((p) => (
        <div key={p.id} className="space-y-2 border-t border-edge pt-3 first:border-0 first:pt-0">
          <p className="text-sm">Vote {p.burnPercent}% burn, {100 - p.burnPercent}% return on battle #{p.battleId}</p>
          <DaoVotePlan namespace={namespace} battleId={p.battleId} burnPercent={p.burnPercent} onDone={() => setPlans(removePlan(browserStore(), p.id))} />
          <Button type="button" variant="ghost" size="sm" onClick={() => setPlans(removePlan(browserStore(), p.id))}>Remove this plan</Button>
        </div>
      ))}
    </Card>
  );
}

/** One chat bubble: the user on the right, the Terminal on the left. */
function Bubble({ side, label, children }: { side: "user" | "terminal"; label: string; children: React.ReactNode }) {
  const mine = side === "user";
  return (
    <div className={mine ? "flex justify-end" : "flex justify-start"}>
      <div className={mine ? "max-w-[88%] sm:max-w-[75%]" : "w-full max-w-[96%] sm:max-w-[85%]"}>
        <p className={`mb-1 text-[10px] uppercase tracking-wide text-mute ${mine ? "text-right" : "text-left"}`}>{label}</p>
        <div
          className={
            mine
              ? "rounded-2xl rounded-br-md border border-neon-green/40 bg-neon-green/10 px-4 py-3 text-sm"
              : "rounded-2xl rounded-bl-md border border-edge bg-void/70 px-4 py-3 text-sm"
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}

const isReadOnly = (intent: LifecycleIntent): boolean => intent.kind === "list_battles" || intent.kind === "show_positions";

/** The part of the answer that acts: the plan for the intent. Only ever rendered for the latest turn. */
function PlanFor({ namespace, intent, onReplace }: { namespace: Namespace; intent: LifecycleIntent; onReplace: Replace }) {
  if (intent.kind === "payout") return <PayoutPlan intent={intent} />;
  if (intent.kind === "create_battle") return <CreatePlan intent={intent} />;
  if (intent.kind === "list_battles") return <ListBattlesPlan namespace={namespace} intent={intent} />;
  if (intent.kind === "show_positions") return <PositionsPlan />;
  if (intent.kind === "claim_winnings") return <ClaimPlan />;
  if (intent.kind === "dao_vote") {
    return intent.battleId === null
      ? <Problems problems={["Which battle? For example: vote burn 50% on battle 7."]} />
      : <DaoVotePlan namespace={namespace} battleId={intent.battleId} burnPercent={intent.burnPercent} />;
  }
  if (intent.kind === "cancel_battle") return <CancelPlan namespace={namespace} intent={intent} />;
  if (intent.kind === "claim_refund") return <RefundPlan namespace={namespace} intent={intent} />;
  if (intent.battleId === null) return <OpenArenaPlan namespace={namespace} intent={intent} onReplace={onReplace} />;
  if (intent.kind === "join_battle") return <JoinPlan namespace={namespace} intent={{ ...intent, battleId: intent.battleId }} />;
  return <ParticipationPlan namespace={namespace} intent={{ ...intent, battleId: intent.battleId }} onReplace={onReplace} />;
}

/** The Terminal's side of one turn: a question back, or what it understood and the plan for it. */
function Answer({ namespace, turn, live, onReplace }: { namespace: Namespace; turn: Turn; live: boolean; onReplace: Replace }) {
  const result = turn.result;
  if (!result) {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-mute" aria-label="Reading your request">
        <span className="inline-flex gap-1" aria-hidden="true">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-mute" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-mute [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-mute [animation-delay:300ms]" />
        </span>
        Reading your request…
      </p>
    );
  }
  if (!result.ok) {
    return (
      <div role="status" aria-label="Clarification" className="space-y-1">
        <p className="text-xs font-semibold text-neon-amber">{result.clarify ? "One more thing" : "Could not read that"}</p>
        <p>{result.error}</p>
        {result.note && <p className="text-xs text-mute">{result.note}</p>}
      </div>
    );
  }
  const intent = result.intent;
  return (
    <div className="space-y-3" aria-label="Understood request">
      <div>
        {result.intents ? (
          <ul className="list-disc pl-4" data-testid="intent-summary">
            {result.intents.map((it, i) => (
              <li key={i}>{describeIntent(it)}</li>
            ))}
          </ul>
        ) : (
          <p data-testid="intent-summary">
            {describeIntent(intent)}
            {intent.kind === "create_battle" ? ` · ${MODE_COPY[intent.mode].name}` : ""}
          </p>
        )}
      </div>
      {live ? (
        <div className="space-y-2 border-t border-edge pt-3">
          <p className="eyebrow text-neon-green">{isReadOnly(intent) ? "YOUR ANSWER" : "REVIEW YOUR ACTION"}</p>
          <p className="text-xs text-mute">{isReadOnly(intent) ? "This only reads; nothing can be signed from here." : "Review the action below before signing."}</p>
          {result.intents ? <MultiPlan namespace={namespace} intents={result.intents} /> : <PlanFor namespace={namespace} intent={intent} onReplace={onReplace} />}
        </div>
      ) : (
        // An earlier answer is a record, not a control: its review and sign buttons are gone, so it cannot be signed by accident.
        <p className="border-t border-edge pt-2 text-xs text-mute" data-testid="earlier-answer">
          Earlier request. Ask again to review it.
        </p>
      )}
    </div>
  );
}

/**
 * Lifecycle intent terminal, as a conversation: your prompts on the right, the Terminal's answers on the left. A
 * prompt is parsed (NEAR AI, with the built-in rules as the fallback) into one validated intent; the latest answer shows
 * it and the same reviewed call the other lifecycle pages use, and only the user pressing "Check transaction preview"
 * contacts the action service. Earlier answers are static. Free text and model output never reach signing.
 */
export function LifecycleTerminal({ namespace }: { namespace: Namespace }) {
  const [prompt, setPrompt] = useState("");
  const [chat, setChat] = useState<Chat>(emptyChat);
  const parser = useMemo(() => createLifecycleRouteParser(), []);
  const logRef = useRef<HTMLDivElement | null>(null);
  // The latest chat, readable inside the async send without waiting for a render.
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const thinking = isThinking(chat);

  // Keep the newest message in view by scrolling the conversation itself, never the page, and not before the first message.
  useEffect(() => {
    const log = logRef.current;
    if (log && chat.turns.length > 0) log.scrollTo?.({ top: log.scrollHeight, behavior: "smooth" });
  }, [chat]);

  async function send(text: string) {
    const typed = text.trim();
    if (!typed || isThinking(chatRef.current)) return;
    setPrompt("");
    const next = ask(chatRef.current, typed);
    chatRef.current = next.chat;
    setChat(next.chat);
    const result = await parser.parse(typed);
    setChat((c) => answer(c, next.id, result));
  }
  /** A choice made inside an answer (a different arena, "join first"): a new turn, which freezes the earlier answer. */
  const replaceIntent: Replace = (next) => {
    setChat((c) => followUp(c, describeIntent(next), next, c.turns[c.turns.length - 1]?.result?.via));
  };

  return (
    <div className="space-y-4">
    <SavedPlans namespace={namespace} />
    <Card className="flex flex-col gap-0 p-0">
      <div
        ref={logRef}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        className="flex h-[55vh] min-h-[24rem] flex-col gap-5 overflow-y-auto p-4 sm:p-6"
      >
        {chat.turns.length === 0 && (
          <Bubble side="terminal" label="Assistant">
            <p>What do you want to do? Write it the way you would say it.</p>
            <p className="mt-2 text-xs text-mute">
              Amounts are plain token amounts (100 or 0.5). You can say “the open arena” instead of a battle number, and ask “which arenas are open?” or “my positions”. Reading your request never submits a transaction.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {EXAMPLES.slice(0, 4).map((ex) => (
                <button key={ex} type="button" className="rounded-full border border-edge px-3 py-1 text-xs hover:border-neon-green/60" onClick={() => void send(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </Bubble>
        )}
        {chat.turns.map((turn) => (
          <div key={turn.id} className="flex flex-col gap-3">
            <Bubble side="user" label="You">
              <p className="whitespace-pre-wrap break-words" data-testid="user-message">{turn.prompt}</p>
            </Bubble>
            <Bubble side="terminal" label="Assistant">
              <Answer namespace={namespace} turn={turn} live={isInteractive(chat, turn.id)} onReplace={replaceIntent} />
            </Bubble>
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(prompt);
        }}
        className="flex items-end gap-2 border-t border-edge p-3 sm:p-4"
      >
        <label className="flex-1">
          <span className="sr-only">Your request (English)</span>
          <textarea
            aria-label="Assistant prompt"
            value={prompt}
            maxLength={MAX_PROMPT_CHARS}
            rows={2}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter adds a line; never while an input method is composing.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(prompt);
              }
            }}
            className="block w-full resize-none rounded-xl border border-edge bg-transparent p-3 text-sm"
            placeholder={EXAMPLES[0]}
          />
        </label>
        <Button type="submit" disabled={thinking || !prompt.trim()}>
          {thinking ? "Reading…" : "Send"}
        </Button>
      </form>
    </Card>
    </div>
  );
}
