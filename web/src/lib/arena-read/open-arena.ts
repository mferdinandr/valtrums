import type { CallReview } from "./create-review";
import type { LifecycleDetail } from "./lifecycle";
import { rpcView } from "./agent-grant";

/**
 * Open arena (D34 to D36): a battle is created with a start time and no invited communities; before the
 * start anyone joins with a token on the protocol allowlist and deposits; at the start the agent locks over
 * the funded communities, or, below two funded, anyone cancels and each depositor pulls a refund. Every
 * review here mirrors the agent's action preview (`agent/src/mcp/actions/lifecycle-actions.ts`) so the
 * service's canonical preview can be compared with it before anything is authorized. The clock only
 * describes the phase; the contract decides whether a join, lock or cancel is accepted.
 */

/** Mirrors the arena's start window: now + 60 s to now + 7 days. */
export const START_MIN_LEAD_MS = 60_000;
export const START_MAX_LEAD_MS = 7 * 24 * 60 * 60 * 1000;
/** Funded communities the lock needs; below this a started battle can be cancelled. */
export const MIN_FUNDED = 2;
export const JOIN_DEPOSIT_YOCTO = "20000000000000000000000";
export const JOIN_GAS_TGAS = "30";
export const CANCEL_GAS_TGAS = "30";
export const REFUND_GAS_TGAS = "60";

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const validAccount = (s: string): boolean => s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);
const MS = /^[1-9][0-9]{0,18}$/;

export type Review = ({ ok: true } & CallReview) | { ok: false; problems: string[] };

export const utc = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

/** Problems with a start time in milliseconds (a decimal string), checked against the arena's window. */
export function startTimeProblems(startAtMs: string | null, nowMs: number): string[] {
  if (!startAtMs) return ["choose a start time"];
  if (!MS.test(startAtMs)) return ["the start time is not a valid time"];
  const lead = Number(startAtMs) - nowMs;
  if (lead < START_MIN_LEAD_MS) return ["the start time must be at least 1 minute from now"];
  if (lead > START_MAX_LEAD_MS) return ["the start time must be at most 7 days from now"];
  return [];
}

/** A `datetime-local` value (the viewer's local time) as epoch milliseconds, or null when empty or invalid. */
export function localInputToMs(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) && ms > 0 ? String(ms) : null;
}

/** Epoch milliseconds as a `datetime-local` value in the viewer's local time, minutes precision. */
export function msToLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const idProblems = (battleId: number): string[] =>
  !Number.isSafeInteger(battleId) || battleId < 1 ? ["battle id must be a positive integer"] : [];
const arenaProblems = (arena: string): string[] => (validAccount(arena) ? [] : ["the arena contract id is not configured"]);

export const joinRequest = (battleId: number, representation: string) => ({ kind: "join_battle", battleId, representation });
export const cancelRequest = (battleId: number) => ({ kind: "cancel_battle", battleId });
export const refundRequest = (battleId: number, community: number) => ({ kind: "claim_refund", battleId, community });

export function buildJoinReview(arena: string, battleId: number, representation: string, label?: string): Review {
  const problems = [
    ...idProblems(battleId),
    ...arenaProblems(arena),
    ...(validAccount(representation) ? [] : ["choose a token to join with"]),
  ];
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    receiver: arena,
    method: "join_lifecycle_battle",
    args: { battle_id: battleId, representation },
    depositYocto: JOIN_DEPOSIT_YOCTO,
    gasTgas: JOIN_GAS_TGAS,
    lines: [
      { label: "Contract", value: arena },
      { label: "Method", value: "join_lifecycle_battle" },
      { label: "Battle", value: `#${battleId}` },
      { label: "Token", value: label ? `${label} · ${representation}` : representation },
      { label: "Storage deposit (upper bound)", value: `${JOIN_DEPOSIT_YOCTO} yoctoNEAR` },
      { label: "Gas", value: `${JOIN_GAS_TGAS} Tgas` },
    ],
    notes: [
      "Joining moves no tokens. It adds this token's community if it is new and saves your spot in it.",
      "The community counts as entered only once it holds a deposit. Deposit after the join confirms.",
      "The arena accepts only tokens on the protocol allowlist and only before the start time.",
    ],
  };
}

export function buildCancelReview(arena: string, battleId: number): Review {
  const problems = [...idProblems(battleId), ...arenaProblems(arena)];
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    receiver: arena,
    method: "cancel_lifecycle_battle",
    args: { battle_id: battleId },
    depositYocto: "0",
    gasTgas: CANCEL_GAS_TGAS,
    lines: [
      { label: "Contract", value: arena },
      { label: "Method", value: "cancel_lifecycle_battle" },
      { label: "Battle", value: `#${battleId}` },
      { label: "Attached deposit", value: "none" },
      { label: "Gas", value: `${CANCEL_GAS_TGAS} Tgas` },
    ],
    notes: [
      "Anyone may cancel once the start time has passed with fewer than two funded communities.",
      "After the cancel each depositor claims their own refund.",
    ],
  };
}

export function buildRefundReview(arena: string, battleId: number, community: number, label?: string): Review {
  const problems = [
    ...idProblems(battleId),
    ...arenaProblems(arena),
    ...(!Number.isSafeInteger(community) || community < 0 || community > 15 ? ["community must be 0 to 15"] : []),
  ];
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    receiver: arena,
    method: "claim_lifecycle_refund",
    args: { battle_id: battleId, community },
    depositYocto: "1",
    gasTgas: REFUND_GAS_TGAS,
    lines: [
      { label: "Contract", value: arena },
      { label: "Method", value: "claim_lifecycle_refund" },
      { label: "Battle / community", value: `#${battleId} / ${label ?? `community ${community + 1}`}` },
      { label: "Attached deposit", value: "1 yoctoNEAR" },
      { label: "Gas", value: `${REFUND_GAS_TGAS} Tgas` },
    ],
    notes: [
      "Returns your whole credited position in this community as its token on NEAR.",
      "The refund is real only after the arena records it; a failed transfer restores your position.",
    ],
  };
}

export const escrowRefundRequest = (battleId: number) => ({ kind: "claim_escrow_refund", battleId });

/** The creator's escrow after a cancel (D41): the same one-yocto claim shape as a position refund, on its own method. */
export function buildEscrowRefundReview(arena: string, battleId: number, label?: string): Review {
  const problems = [...idProblems(battleId), ...arenaProblems(arena)];
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    receiver: arena,
    method: "claim_lifecycle_escrow_refund",
    args: { battle_id: battleId },
    depositYocto: "1",
    gasTgas: REFUND_GAS_TGAS,
    lines: [
      { label: "Contract", value: arena },
      { label: "Method", value: "claim_lifecycle_escrow_refund" },
      { label: "Battle", value: `#${battleId}${label ? ` / ${label}` : ""}` },
      { label: "Attached deposit", value: "1 yoctoNEAR" },
      { label: "Gas", value: `${REFUND_GAS_TGAS} Tgas` },
    ],
    notes: [
      "Returns the deposit you made when you created this battle, which the arena was still holding in escrow.",
      "The refund is real only after the arena records it; a failed transfer restores the escrow.",
    ],
  };
}

export type OpenPhase =
  /** Created without a start time: the earlier rules, never cancellable. */
  | { kind: "no_start" }
  | { kind: "gathering"; startAtMs: number; msLeft: number }
  /** Start passed with enough funded communities: the agent's lock is due. */
  | { kind: "awaiting_lock"; startAtMs: number }
  | { kind: "cancellable"; startAtMs: number }
  | { kind: "cancelled" }
  | { kind: "locked" };

export const isFunded = (vault: string): boolean => /^[0-9]+$/.test(vault) && BigInt(vault) > 0n;

export function fundedCount(detail: LifecycleDetail): number {
  return detail.battle.communities.filter((c) => isFunded(c.vault)).length;
}

/** Where an open battle is before its lock. The clock never locks, cancels or refunds anything. */
export function openPhase(detail: LifecycleDetail, nowMs: number): OpenPhase {
  const b = detail.battle;
  if (b.cancelled === true) return { kind: "cancelled" };
  if (b.locked) return { kind: "locked" };
  if (!b.start_at_ms || !MS.test(b.start_at_ms)) return { kind: "no_start" };
  const startAtMs = Number(b.start_at_ms);
  if (nowMs <= 0 || nowMs < startAtMs) return { kind: "gathering", startAtMs, msLeft: Math.max(0, startAtMs - nowMs) };
  return fundedCount(detail) >= MIN_FUNDED ? { kind: "awaiting_lock", startAtMs } : { kind: "cancellable", startAtMs };
}

/** One allowlisted token as the arena returns it from `get_lifecycle_joinable_assets`. */
export interface JoinableAsset {
  chain_id: string;
  token_address: string;
  representation: string;
  custody_domain: string;
  reference_chain_id: string | null;
  reference_address: string | null;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
const PAGE = 50;
const MAX_JOINABLE = 64;

/** The whole allowlist, read page by page over RPC (the arena caps it at 64 entries). Read-only. */
export async function readJoinableAssets(rpcUrl: string, arena: string, doFetch?: FetchLike): Promise<JoinableAsset[]> {
  const out: JoinableAsset[] = [];
  while (out.length < MAX_JOINABLE) {
    const page = await rpcView<JoinableAsset[]>(rpcUrl, arena, "get_lifecycle_joinable_assets", { from_index: String(out.length), limit: String(PAGE) }, doFetch);
    if (!Array.isArray(page) || page.length === 0) break;
    for (const a of page) {
      if (!a || typeof a.representation !== "string" || typeof a.token_address !== "string" || typeof a.chain_id !== "string") {
        throw new Error("the arena returned a malformed joinable asset");
      }
      out.push(a);
    }
    if (page.length < PAGE) break;
  }
  return out;
}
