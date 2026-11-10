import type { CallReview } from "./create-review";
import type { ReadEnvelope } from "./client";

/**
 * Pure model of the lifecycle portfolio (#151). Positions, entitlements, transfers, late funds, DAO principal
 * and alerts stay separate and asset-bound. Amounts are exact integer strings; nothing is summed across assets,
 * an empty list is never read as a zero or as "no payouts" unless the source says its history is complete, and
 * a reserved or broadcast payout is never "paid".
 */

const UINT = /^(0|[1-9][0-9]{0,77})$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** `request_payout` storage deposit (30 mNEAR); the unused part is refunded. Mirrors agent/src/mcp/actions/preview.ts. */
export const PAYOUT_DEPOSIT_YOCTO = "30000000000000000000000";
export const PAYOUT_GAS_TGAS = "150";

// ---------------------------------------------------------------- positions

export interface PositionsData {
  accountId: string;
  positions: { battleId: number; community: number; representation?: string; amount: string }[];
}

export interface PositionRow {
  key: string;
  battleId: number;
  community: number;
  /** The original asset's NEP-141 representation (its identity); amounts of different assets are never added. */
  asset: string;
  amount: string;
  valid: boolean;
}

export interface AssetGroup {
  asset: string;
  rows: PositionRow[];
  /** Exact sum of this asset's rows only; null when one amount was malformed. */
  subtotal: string | null;
}

export function normalizePositions(data: PositionsData): AssetGroup[] {
  const rows: PositionRow[] = data.positions.map((p) => ({
    key: `pos:${p.battleId}:${p.community}`,
    battleId: p.battleId,
    community: p.community,
    asset: p.representation ?? "unknown asset",
    amount: p.amount,
    valid: UINT.test(p.amount),
  }));
  const groups = new Map<string, PositionRow[]>();
  for (const r of rows) groups.set(r.asset, [...(groups.get(r.asset) ?? []), r]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([asset, list]) => ({
      asset,
      rows: list.sort((a, b) => a.battleId - b.battleId || a.community - b.community),
      subtotal: list.every((r) => r.valid) ? list.reduce((s, r) => s + BigInt(r.amount), 0n).toString() : null,
    }));
}

// ------------------------------------------------------- entitlements note

export type Availability = { available: true } | { available: false; reason: string };

/**
 * `inspect_entitlements` reports `available: false` because no deployed contract exposes per-account
 * entitlements. That is "not available", never zero, whatever the (empty) list contains.
 */
export function entitlementAvailability(data: { available?: boolean } | null, limitations: string[]): Availability {
  if (data?.available === true) return { available: true };
  const reason = limitations.find((l) => /entitlement/i.test(l)) ?? "the read service does not report per-account entitlements";
  return { available: false, reason };
}

// --------------------------------------------------------------- history

export interface HistoryNote {
  complete: boolean;
  /** Always shown with the payout list: what the list can not tell the user. */
  notes: string[];
}

/**
 * A payout list is complete only when the source reports no bound or omission. Terminal payouts are not listed by
 * the payout contract and the scan is bounded, so those limitations are surfaced and "no payouts" is never claimed.
 */
export function historyNote(limitations: string[]): HistoryNote {
  const bounded = limitations.filter((l) => /only the|not listed|first \d+/i.test(l));
  return { complete: bounded.length === 0, notes: bounded.length > 0 ? bounded : [] };
}

export function emptyPayoutsText(note: HistoryNote): string {
  return note.complete
    ? "The source reports a complete history with no payout for this account."
    : "No unresolved payout was found in the scanned range. This is not proof that you have no payouts: history is incomplete.";
}

// ------------------------------------------------------------ transfers

export interface PayoutItem {
  state: string;
  displayState: string;
  displayLabel: string;
  terminal: boolean;
  chainId: string;
  amount: string;
  backing: string;
}

export interface PayoutRow {
  key: string;
  backing: string;
  amount: string;
  stage: "reserved" | "in_flight" | "paid" | "reverted" | "restored" | "unknown";
  /** True only for a confirmed, finalized, verified receipt. */
  paid: boolean;
  /** Unresolved: the request can still move; used to block a duplicate request. */
  unresolved: boolean;
  label: string;
  detail: string;
}

const STAGE: Record<string, PayoutRow["stage"]> = {
  reserved: "reserved",
  broadcast: "in_flight",
  confirmation_pending: "in_flight",
  confirmed: "paid",
  reverted: "reverted",
  restored: "restored",
};

export function describePayouts(items: PayoutItem[]): PayoutRow[] {
  return items.map((p, i) => {
    const stage = STAGE[p.displayState] ?? "unknown";
    const paid = stage === "paid";
    return {
      key: `payout:${p.backing}:${i}`,
      backing: p.backing,
      amount: p.amount,
      stage,
      paid,
      unresolved: !p.terminal || stage === "unknown",
      label: paid ? "Paid (confirmed)" : p.displayLabel,
      detail: paid
        ? "A finalized receipt was verified."
        : stage === "restored"
          ? "No transfer happened; the amount returned to the entitlement."
          : "Not paid: a reservation, signature or broadcast is not a delivered payout.",
    };
  });
}

// -------------------------------------------------------- payout request

export interface PayoutDraft {
  backing: string;
  amount: string;
  destination: string;
}

export function validatePayoutDraft(d: PayoutDraft): string[] {
  const out: string[] = [];
  if (!(d.backing.length >= 2 && d.backing.length <= 64 && ACCOUNT_RE.test(d.backing))) out.push("choose the backing (original asset) to pay out");
  if (!/^[1-9][0-9]{0,38}$/.test(d.amount)) out.push("amount must be a positive integer in token base units");
  if (!EVM.test(d.destination)) out.push("destination must be a 20-byte hex address (0x + 40 hex digits)");
  else if (/^0x0{40}$/i.test(d.destination)) out.push("destination must not be the zero address");
  return out;
}

/** The request the action service previews. Nothing is signed from this. */
export function payoutRequest(d: PayoutDraft, requestId: string): Record<string, unknown> {
  return { kind: "payout", backing: d.backing, amount: d.amount, destination: d.destination.toLowerCase(), requestId };
}

const bytes = (hex: string): number[] => (hex.match(/../g) ?? []).map((b) => parseInt(b, 16));

export type PayoutReview = ({ ok: true } & CallReview) | { ok: false; problems: string[] };

/** The exact `request_payout` call a wallet will be asked to sign; compared to the canonical preview before authorizing. */
export function buildPayoutReview(payoutContract: string | null, d: PayoutDraft, requestId: string): PayoutReview {
  const problems = [...validatePayoutDraft(d)];
  if (!payoutContract || !ACCOUNT_RE.test(payoutContract)) problems.push("the payout contract is not configured for this deployment");
  if (!isValidRequestId(requestId)) problems.push("the request id must be 32 non-zero bytes");
  if (problems.length > 0 || !payoutContract) return { ok: false, problems };
  return {
    ok: true,
    receiver: payoutContract,
    method: "request_payout",
    args: { backing: d.backing, request_id: bytes(requestId), amount: d.amount, destination: bytes(d.destination.slice(2).toLowerCase()) },
    depositYocto: PAYOUT_DEPOSIT_YOCTO,
    gasTgas: PAYOUT_GAS_TGAS,
    lines: [
      { label: "Contract", value: payoutContract },
      { label: "Method", value: "request_payout" },
      { label: "Original asset (backing)", value: d.backing },
      { label: "Amount", value: `${d.amount} base units` },
      { label: "Destination (Robinhood Chain)", value: d.destination.toLowerCase() },
      { label: "Request id", value: requestId },
      { label: "Storage deposit (upper bound)", value: `${PAYOUT_DEPOSIT_YOCTO} yoctoNEAR` },
      { label: "Gas", value: `${PAYOUT_GAS_TGAS} Tgas` },
    ],
    notes: [
      "This requests a payout; it does not deliver tokens. The request is reserved, signed, broadcast and confirmed by separate roles.",
      "A confirmed NEAR transaction is not a paid payout. It is paid only when its source-chain receipt is verified.",
      "The same request id is reused if you retry, so a retry cannot create a second payout.",
    ],
  };
}

// ----------------------------------------------------------- request ids

export const isValidRequestId = (id: string): boolean => HEX32.test(id) && !/^0{64}$/.test(id);

export function newRequestId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  for (let i = 0; i < 8; i++) {
    const hex = [...random(32)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (isValidRequestId(hex)) return hex;
  }
  throw new Error("could not generate a request id");
}

/** The slice of Storage this needs. Injected so it is testable and can be absent (private window, blocked storage). */
export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/**
 * Stable request ids across reloads. Only the id is stored: it is an idempotency key that carries no authority,
 * so browser storage is acceptable here (the session token never is). The key binds the id to the exact request
 * (account, deployment, backing, amount, destination): changing any field yields a different request and id.
 * When storage fails the id lives in memory for the page and the caller is told it is not persisted.
 */
export class RequestIdStore {
  private readonly memory = new Map<string, string>();
  constructor(private readonly store: KeyValueStore | null, private readonly random?: (n: number) => Uint8Array) {}

  static key(account: string, deployment: string, d: PayoutDraft): string {
    return `valtrum.payout-request:${JSON.stringify([account, deployment, d.backing, d.amount, d.destination.toLowerCase()])}`;
  }

  /** Existing id for this exact request, or a new one that is saved before anything is previewed. */
  obtain(account: string, deployment: string, d: PayoutDraft): { requestId: string; reused: boolean; persisted: boolean } {
    const key = RequestIdStore.key(account, deployment, d);
    let stored: string | null = this.memory.get(key) ?? null;
    try { stored ??= this.store?.getItem(key) ?? null; } catch { /* storage unavailable */ }
    if (stored && isValidRequestId(stored)) return { requestId: stored, reused: true, persisted: this.store !== null };
    const requestId = newRequestId(this.random);
    this.memory.set(key, requestId);
    let persisted = false;
    try { this.store?.setItem(key, requestId); persisted = this.store !== null; } catch { /* kept in memory only */ }
    return { requestId, reused: false, persisted };
  }

  /** After a confirmed or restored outcome a new request is a new payout. */
  release(account: string, deployment: string, d: PayoutDraft): void {
    const key = RequestIdStore.key(account, deployment, d);
    this.memory.delete(key);
    try { this.store?.removeItem(key); } catch { /* ignore */ }
  }
}

// ------------------------------------------------------ capability gate

export interface DeploymentCapabilities {
  deploymentId: string;
  companions: { payout: string | null };
  capabilities: { custody?: { enabled: boolean; reasons: string[] } };
}

export interface CustodyHealth {
  sourceTransfersEnabled: boolean | null;
  reasons: string[];
}

export interface Entitlement {
  backing: string;
  available: string;
}

export interface PayoutGate {
  enabled: boolean;
  /** Every unmet requirement, specific. Empty when enabled. */
  reasons: string[];
}

/**
 * Payout requests need ALL of: a connected wallet, a payout contract, the custody capability and a proven spendable
 * custody path (#148), and a positive entitlement for the chosen backing that covers the amount. Status reads never
 * depend on this gate.
 */
export function payoutGate(input: {
  connected: boolean;
  capabilities: DeploymentCapabilities | null | undefined;
  custody: CustodyHealth | null;
  entitlements: Entitlement[] | null;
  draft: PayoutDraft | null;
}): PayoutGate {
  const reasons: string[] = [];
  if (!input.connected) reasons.push("connect a wallet");
  const caps = input.capabilities;
  if (!caps) reasons.push("deployment capabilities could not be read");
  else {
    if (!caps.companions.payout) reasons.push("no payout contract is configured for this deployment");
    const custody = caps.capabilities.custody;
    if (!custody) reasons.push("the custody capability is not declared: payouts stay disabled (#148)");
    else if (!custody.enabled) reasons.push(`custody capability disabled: ${custody.reasons.join("; ")}`);
  }
  if (!input.custody) reasons.push("custody health could not be read");
  else if (input.custody.sourceTransfersEnabled !== true) {
    reasons.push(`source-chain transfers are not enabled: no custody path is proven spendable (#148)${input.custody.reasons[0] ? ` (${input.custody.reasons[0]})` : ""}`);
  }
  if (input.entitlements === null) reasons.push("your entitlements have not been read yet");
  else {
    const mine = input.draft ? input.entitlements.filter((e) => e.backing === input.draft?.backing) : input.entitlements;
    const positive = mine.filter((e) => UINT.test(e.available) && BigInt(e.available) > 0n);
    if (positive.length === 0) reasons.push("no positive entitlement is reported for this asset (an unreadable entitlement is not a positive one)");
    else if (input.draft && UINT.test(input.draft.amount) && input.draft.amount !== "" && BigInt(input.draft.amount) > BigInt(positive[0]!.available)) {
      reasons.push(`the amount exceeds the available entitlement ${positive[0]!.available}`);
    }
  }
  return { enabled: reasons.length === 0, reasons };
}

/**
 * Reconcile before any retry: a new request is blocked while the status read failed or an unresolved payout for the
 * same asset and amount exists (it may be this very request after a reload).
 */
export function reconcileGate(payouts: PayoutRow[] | null, draft: Pick<PayoutDraft, "backing" | "amount">): string[] {
  if (payouts === null) return ["payout status has not been read: reconcile before requesting"];
  return payouts
    .filter((p) => p.unresolved && p.backing === draft.backing && p.amount === draft.amount)
    .map(() => "an unresolved payout for the same asset and amount exists; wait for it to finish or be restored before requesting again");
}

// ------------------------------------------------------ stale responses

/** One account at a time: starting a read aborts the previous one, and only the newest sequence may commit. */
export class LatestRead {
  private seq = 0;
  private controller: AbortController | null = null;
  private owner: string | null = null;

  begin(owner: string): { signal: AbortSignal; isCurrent: () => boolean } {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.owner = owner;
    const mine = ++this.seq;
    return { signal: controller.signal, isCurrent: () => mine === this.seq && this.owner === owner && !controller.signal.aborted };
  }

  /** Sign-out or an account change: nothing in flight may commit any more. */
  cancel(): void {
    this.controller?.abort();
    this.controller = null;
    this.owner = null;
    this.seq++;
  }
}

// ----------------------------------------------------------- labels

export function envelopeLabel(env: Pick<ReadEnvelope<unknown>, "source" | "observedAt" | "freshness">, nowMs: number): string {
  const kind = env.source.kind === "fixture" ? "FIXTURE (not live)" : env.source.kind;
  const age = env.observedAt ? nowMs - Date.parse(env.observedAt) : Number.NaN;
  const fresh = env.freshness !== "unknown" ? env.freshness : Number.isNaN(age) ? "freshness unknown" : age > 60_000 ? "stale" : "fresh";
  return `${kind} · ${env.source.name} · observed ${env.observedAt ?? "unknown"} · ${fresh}`;
}
