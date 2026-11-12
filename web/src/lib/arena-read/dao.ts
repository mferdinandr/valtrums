import type { CallReview } from "./create-review";
import { rpcView } from "./agent-grant";

/**
 * DAO decision on the winning principal (D22, D24): winners vote burn or return inside a window, then anyone
 * reserves the escrow and executes the decided releases. The reviews mirror the action service's preview
 * (`agent/src/mcp/actions/lifecycle-actions.ts`) field for field so the canonical preview can be compared
 * with them before the wallet is asked for anything. The clock only describes the window; the arena decides.
 */

export const VOTE_DEPOSIT_YOCTO = "10000000000000000000000";
export const ESCROW_DEPOSIT_YOCTO = "10000000000000000000000";
export const ENTITLEMENT_DEPOSIT_YOCTO = 10_000_000_000_000_000_000_000n;
export const MAX_EXECUTE_BATCH = 10;
export const VOTE_GAS_TGAS = "30";
export const ESCROW_GAS_TGAS = "80";
export const EXECUTE_GAS_TGAS = "250";

export type DispositionStatus = "no_winner" | "no_vote" | "voting" | "undecided_escrowed" | "decided";

/** `get_lifecycle_disposition` as the arena returns it. */
export interface Disposition {
  status: DispositionStatus;
  window_secs: string | null;
  opens_at_ns: string | null;
  closes_at_ns: string | null;
  burn_weight: string;
  return_weight: string;
  escrow_reserved: boolean;
  burn_total: string;
  return_total: string;
  released: number;
  total_releases: number;
}

const STATUSES: readonly string[] = ["no_winner", "no_vote", "voting", "undecided_escrowed", "decided"];
const UINT = /^(0|[1-9][0-9]*)$/;

/** The arena's disposition view, or null for an unknown battle. A malformed answer throws rather than guesses. */
export async function readDisposition(rpcUrl: string, arena: string, battleId: number): Promise<Disposition | null> {
  const v = await rpcView<Partial<Disposition>>(rpcUrl, arena, "get_lifecycle_disposition", { battle_id: String(battleId) });
  if (!v) return null;
  if (typeof v.status !== "string" || !STATUSES.includes(v.status)) throw new Error("the arena returned a malformed disposition");
  for (const key of ["burn_weight", "return_weight", "burn_total", "return_total"] as const) {
    if (typeof v[key] !== "string" || !UINT.test(v[key] as string)) throw new Error("the arena returned a malformed disposition");
  }
  return {
    status: v.status as DispositionStatus,
    window_secs: v.window_secs ?? null,
    opens_at_ns: v.opens_at_ns ?? null,
    closes_at_ns: v.closes_at_ns ?? null,
    burn_weight: v.burn_weight as string,
    return_weight: v.return_weight as string,
    escrow_reserved: v.escrow_reserved === true,
    burn_total: v.burn_total as string,
    return_total: v.return_total as string,
    released: typeof v.released === "number" ? v.released : 0,
    total_releases: typeof v.total_releases === "number" ? v.total_releases : 0,
  };
}

/** Milliseconds left in the vote window; 0 once it has closed or when the clock is not read yet. */
export function voteMsLeft(d: Disposition, nowMs: number): number {
  if (d.status !== "voting" || !d.closes_at_ns || nowMs <= 0) return 0;
  return Math.max(0, Number(BigInt(d.closes_at_ns) / 1_000_000n) - nowMs);
}

/** Burn share of the weight cast in whole percent (rounded down), or null while no vote is cast. */
export function burnSharePercent(d: Disposition): number | null {
  const burn = BigInt(d.burn_weight);
  const total = burn + BigInt(d.return_weight);
  return total === 0n ? null : Number((burn * 100n) / total);
}

export type DaoStep =
  | { kind: "none"; reason: string }
  | { kind: "voting" }
  | { kind: "undecided" }
  | { kind: "reserve_escrow" }
  | { kind: "execute"; batch: number; remaining: number }
  | { kind: "done" };

/** What the next permissionless step of a battle's disposition is. The arena re-checks every one of them. */
export function daoStep(d: Disposition | null): DaoStep {
  if (!d || d.status === "no_winner") return { kind: "none", reason: "No final winner is recorded yet." };
  if (d.status === "no_vote") return { kind: "none", reason: "This battle was created without a vote window; the winning principal stays escrowed." };
  if (d.status === "voting") return { kind: "voting" };
  if (d.status === "undecided_escrowed") return { kind: "undecided" };
  if (!d.escrow_reserved) return { kind: "reserve_escrow" };
  const remaining = d.total_releases - d.released;
  if (remaining <= 0) return { kind: "done" };
  return { kind: "execute", batch: Math.min(MAX_EXECUTE_BATCH, remaining), remaining };
}

const idProblems = (battleId: number): string[] =>
  !Number.isSafeInteger(battleId) || battleId < 1 ? ["battle id must be a positive integer"] : [];
const arenaProblems = (arena: string): string[] => (arena.length >= 2 ? [] : ["the arena contract id is not configured"]);

export type Review = ({ ok: true } & CallReview) | { ok: false; problems: string[] };

export const voteRequest = (battleId: number, burnPercent: number) => ({ kind: "vote_disposition", battleId, burnPercent });
export const reserveEscrowRequest = (battleId: number) => ({ kind: "reserve_escrow", battleId });
export const executeRequest = (battleId: number) => ({ kind: "execute_disposition", battleId });

export function buildVoteReview(arena: string, battleId: number, burnPercent: number, weightLabel?: string): Review {
  const problems = [...idProblems(battleId), ...arenaProblems(arena)];
  if (!Number.isInteger(burnPercent) || burnPercent < 0 || burnPercent > 100) problems.push("the burn share must be a whole number from 0 to 100");
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    receiver: arena,
    method: "vote_lifecycle_disposition",
    args: { battle_id: String(battleId), burn_percent: burnPercent },
    depositYocto: VOTE_DEPOSIT_YOCTO,
    gasTgas: VOTE_GAS_TGAS,
    lines: [
      { label: "Contract", value: arena },
      { label: "Method", value: "vote_lifecycle_disposition" },
      { label: "Battle", value: `#${battleId}` },
      { label: "Burn share", value: `${burnPercent}% burned, ${100 - burnPercent}% returned` },
      ...(weightLabel ? [{ label: "Your weight", value: weightLabel }] : []),
      { label: "Storage deposit (upper bound)", value: `${VOTE_DEPOSIT_YOCTO} yoctoNEAR` },
      { label: "Gas", value: `${VOTE_GAS_TGAS} Tgas` },
    ],
    notes: [
      "One vote per account, and it is final.",
      "No quorum: the weighted average of all burn shares applies to every winner's principal, rounding toward return.",
      "The arena refunds the part of the deposit the vote does not use.",
    ],
  };
}

export function buildReserveEscrowReview(arena: string, battleId: number): Review {
  const problems = [...idProblems(battleId), ...arenaProblems(arena)];
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    receiver: arena,
    method: "reserve_lifecycle_escrow",
    args: { battle_id: String(battleId) },
    depositYocto: ESCROW_DEPOSIT_YOCTO,
    gasTgas: ESCROW_GAS_TGAS,
    lines: [
      { label: "Contract", value: arena },
      { label: "Method", value: "reserve_lifecycle_escrow" },
      { label: "Battle", value: `#${battleId}` },
      { label: "Storage deposit (upper bound)", value: `${ESCROW_DEPOSIT_YOCTO} yoctoNEAR` },
      { label: "Gas", value: `${ESCROW_GAS_TGAS} Tgas` },
    ],
    notes: ["Anyone may do this. It reserves the winning principal in the backing's escrow, which a decided disposition needs.", "The arena refunds the excess deposit."],
  };
}

export function buildExecuteReview(arena: string, battleId: number, batch: number, remaining: number): Review {
  const problems = [...idProblems(battleId), ...arenaProblems(arena)];
  if (!Number.isInteger(batch) || batch < 1 || batch > MAX_EXECUTE_BATCH) problems.push("the batch must be 1 to 10 releases");
  if (problems.length > 0) return { ok: false, problems };
  const deposit = (ENTITLEMENT_DEPOSIT_YOCTO * BigInt(batch)).toString();
  return {
    ok: true,
    receiver: arena,
    method: "execute_lifecycle_disposition",
    args: { battle_id: String(battleId), max_releases: batch },
    depositYocto: deposit,
    gasTgas: EXECUTE_GAS_TGAS,
    lines: [
      { label: "Contract", value: arena },
      { label: "Method", value: "execute_lifecycle_disposition" },
      { label: "Battle", value: `#${battleId}` },
      { label: "Releases in this batch", value: `${batch} of ${remaining} remaining` },
      { label: "Attached deposit", value: `${deposit} yoctoNEAR` },
      { label: "Gas", value: `${EXECUTE_GAS_TGAS} Tgas` },
    ],
    notes: [
      "Anyone may execute once the vote window has closed. The arena refunds unused deposit.",
      "A recorded burn is a reservation for the sink, not a confirmed burn on Robinhood.",
      "Repeat until every release is recorded.",
    ],
  };
}
