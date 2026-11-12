"use client";
import { TransactionLink } from "@/components/transaction-link";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/input";
import { useLifecycleCreate } from "@/hooks/use-lifecycle-create";
import { usePortfolio } from "@/hooks/use-portfolio";
import { useJoinableAssets } from "@/hooks/use-joinable-assets";
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
import { MODE_COPY } from "@/lib/arena-read/lifecycle-presentation";
import {
  MAX_PROMPT_CHARS,
  describeIntent,
  intentToRequest,
  type LifecycleIntent,
  type LifecycleParseResult,
} from "@/lib/terminal/lifecycle-intent";
import { chooseArena, communityForToken, openArenasOf, type OpenArena } from "@/lib/terminal/lifecycle-open";
import { createLifecycleRouteParser } from "@/lib/terminal/lifecycle-parse-client";
import { resolveJoinToken, type JoinTokenResult, type RegistryAsset } from "@/lib/terminal/lifecycle-resolve";
import { isHiddenAsset } from "@/lib/arena-read/hidden-assets";

const EXAMPLES = [
  "deposit 100 CASHCAT ke arena yang open",
  "which arenas are open?",
  "join the open arena with CASHCAT",
  "my positions",
  "create price gain battle in 15 minutes",
  "cancel battle 7",
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

type Known<K extends LifecycleIntent["kind"]> = Omit<Extract<LifecycleIntent, { kind: K }>, "battleId"> & { battleId: number };
type Replace = (next: LifecycleIntent) => void;

function ParticipationPlan({
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
  // A deposit may name its community by token. It is looked up in this battle's own communities and never guessed.
  const byToken = useMemo(
    () => (intent.kind === "deposit" && intent.community === null && intent.tokenRef !== null ? communityForToken(intent.tokenRef, rows) : null),
    [intent, rows],
  );
  const community: number | null = intent.community !== null ? intent.community : byToken?.kind === "one" ? byToken.index : null;
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
  if (intent.kind === "deposit" && intent.community === null && intent.tokenRef !== null) {
    if (byToken?.kind === "none") {
      return (
        <div className="space-y-2" role="status">
          <p className="text-sm text-neon-amber">Battle #{intent.battleId} has no {intent.tokenRef} community yet.</p>
          <Button type="button" variant="ghost" onClick={() => onReplace({ kind: "join_battle", battleId: intent.battleId, tokenRef: intent.tokenRef! })}>
            Join battle #{intent.battleId} with {intent.tokenRef} first
          </Button>
          <p className="text-xs text-mute">Joining adds the community; then ask for the deposit again.</p>
        </div>
      );
    }
    if (byToken?.kind === "many") {
      return (
        <div className="space-y-2" role="status">
          <p className="text-sm">More than one community in battle #{intent.battleId} uses {intent.tokenRef}. Which one?</p>
          <div className="flex flex-wrap gap-2">
            {byToken.indexes.map((i) => (
              <Button key={i} type="button" variant="ghost" onClick={() => onReplace({ ...intent, community: i, tokenRef: null })}>
                Community {i + 1}
              </Button>
            ))}
          </div>
        </div>
      );
    }
  }
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
        {choice.joinable.length > 0 && intent.kind === "deposit" && intent.tokenRef !== null && (
          <ul className="space-y-2">
            {choice.joinable.map((a) => (
              <li key={a.battleId} className="flex flex-wrap items-center gap-2 text-xs">
                <ArenaLine arena={a} />
                <Button type="button" variant="ghost" onClick={() => onReplace({ kind: "join_battle", battleId: a.battleId, tokenRef: intent.tokenRef! })}>
                  Join with {intent.tokenRef}
                </Button>
              </li>
            ))}
          </ul>
        )}
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

/** "My positions": the wallet-signed read the Portfolio page uses. Read-only: it never prepares or signs an action. */
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
      {(state.step === "opening-session" || state.step === "reading") && <p role="status" className="text-xs text-mute">Reading your positions (your wallet may ask you to sign a read session)…</p>}
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
      <p className="text-xs text-mute">Winnings are paid out on Robinhood Chain; see Portfolio.</p>
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
  /** A follow-up the user chose (a different arena, "join first"): validated like any intent, shown in the same place. */
  const replaceIntent: Replace = (next) => {
    setResult((r) => ({ ok: true, intent: next, ...(r?.via ? { via: r.via } : {}) }));
    setRunId((n) => n + 1);
  };
  const intent = result?.ok ? result.intent : null;
  const parserLine = result?.via ? (result.via === "near-ai" ? "Understood by NEAR AI" : "Understood by the built-in rules") : null;
  return (
    <div className="space-y-6">
      <Card>
        <CardTitle>Tell us what you want to do</CardTitle>
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
            {EXAMPLES.slice(0, 4).map((ex) => (
              <button key={ex} type="button" className="text-xs underline text-mute" onClick={() => setPrompt(ex)}>
                {ex}
              </button>
            ))}
          </div>
          <p className="text-xs text-mute">
            Reading your request won’t submit a transaction. Write amounts as plain token amounts (100 or 0.5); you can say “the open arena” instead of a battle number, and ask “which arenas are open?” or “my positions”.
          </p>
        </form>
      </Card>

      {result && !result.ok && (
        <Card role="status" aria-label="Clarification">
          <CardTitle>{result.clarify ? "One more thing" : "Could not read that"}</CardTitle>
          <p className="text-sm">{result.error}</p>
          {result.note && <p className="mt-2 text-xs text-mute">{result.note}</p>}
        </Card>
      )}

      {intent && (
        <Card aria-label="Understood request" key={runId}>
          <CardTitle>Here’s what I understood</CardTitle>
          <p className="mb-1 text-sm" data-testid="intent-summary">
            {describeIntent(intent)}
            {intent.kind === "create_battle" ? ` · ${MODE_COPY[intent.mode].name}` : ""}
          </p>
          {parserLine && (
            <p className="mb-1 text-xs text-mute" data-testid="parser-line">
              {parserLine}
              {result?.note ? `. ${result.note}` : ""}
            </p>
          )}
          <p className="mb-4 text-xs text-mute">
            {intent.kind === "list_battles" || intent.kind === "show_positions" ? "This only reads; nothing can be signed from here." : "Review the action below before signing."}
          </p>
          <p className="eyebrow mb-3 text-neon-green">{intent.kind === "list_battles" || intent.kind === "show_positions" ? "YOUR ANSWER" : "REVIEW YOUR ACTION"}</p>
          {intent.kind === "payout" ? (
            <PayoutPlan intent={intent} />
          ) : intent.kind === "create_battle" ? (
            <CreatePlan intent={intent} />
          ) : intent.kind === "list_battles" ? (
            <ListBattlesPlan namespace={namespace} intent={intent} />
          ) : intent.kind === "show_positions" ? (
            <PositionsPlan />
          ) : intent.kind === "cancel_battle" ? (
            <CancelPlan namespace={namespace} intent={intent} />
          ) : intent.kind === "claim_refund" ? (
            <RefundPlan namespace={namespace} intent={intent} />
          ) : intent.battleId === null ? (
            <OpenArenaPlan namespace={namespace} intent={intent} onReplace={replaceIntent} />
          ) : intent.kind === "join_battle" ? (
            <JoinPlan namespace={namespace} intent={{ ...intent, battleId: intent.battleId }} />
          ) : (
            <ParticipationPlan namespace={namespace} intent={{ ...intent, battleId: intent.battleId }} onReplace={replaceIntent} />
          )}
        </Card>
      )}
    </div>
  );
}
