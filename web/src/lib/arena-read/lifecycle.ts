import { fetchApplication, type ApplicationEnvelope, type Namespace } from "./application";

/**
 * Client model of one lifecycle battle read through the versioned application route
 * `GET battles/{id}` (issue #149). It mirrors the agent's wire DTO (snake_case contract fields, u64 and
 * u128 as decimal strings) and keeps the lifecycle economics isolated from the legacy A/B types: nothing
 * here is mapped onto `BattleView`. Every helper is pure: the clock can describe where a round is, but
 * only the contract's recorded winner can say who won.
 */

export type ScoringMode = "PriceGain" | "MarketCapGrowth" | "VolumeRatio" | "LowestDrawdown";

export interface LifecycleCommunity {
  chain_id: string;
  token_address: string;
  representation: string;
  custody_domain: string;
  reference_chain_id: string | null;
  reference_address: string | null;
  vault: string;
  audit_policy_hash: string | null;
  audit_evidence_hash: string | null;
  audit_expires_at_ms: string | null;
  backing_evidence_hash: string | null;
}
export interface LifecycleBattle {
  creator: string;
  protocol: string;
  protocol_created: boolean;
  fee_bps: number;
  creator_share_bps: number;
  mode: ScoringMode;
  locked: boolean;
  observation_policy_version: string | null;
  observation_policy_hash: string | null;
  principal_community: number | null;
  principal_amount: string | null;
  /** Zero to sixteen; an open battle starts empty and grows by joins. */
  communities: LifecycleCommunity[];
  /** Open arena start time (u64 ms as a decimal string); null or absent for a battle without one. */
  start_at_ms?: string | null;
  /** Absent on an older service; true once the battle was cancelled. */
  cancelled?: boolean;
}
export interface LifecycleRound {
  round_id: string;
  candidates: number[];
  start_ns: string | null;
  end_ns: string | null;
  winner: number | null;
}
export interface BackingReadiness {
  community: number;
  representation: string;
  trusted: boolean;
  asset_matches: boolean;
  evidence_hash: string | null;
  expires_at_ms: string | null;
  fresh: boolean;
}
export interface LifecycleReadiness {
  schema_version: string;
  activated: boolean;
  paused: boolean;
  legacy_battle_count: string;
  activation_blocked_by_legacy: boolean;
  protocol: string | null;
  oracle: string | null;
  audit_policy_hash: string | null;
  battle_found: boolean | null;
  backings: BackingReadiness[] | null;
}
export interface StoredRound {
  round_id: string;
  outcome: unknown;
  complete: false;
  reason: string;
}
/** A curated display name for a token. Identity is always chainId + address; a label never implies eligibility. */
export interface TokenLabel {
  symbol: string;
  name: string;
  kind: "testnet-mock" | "mainnet-reference";
}

export interface LifecycleDetail {
  battleId: string;
  battle: LifecycleBattle;
  round: LifecycleRound | null;
  readiness: LifecycleReadiness | null;
  history: { items: StoredRound[]; next_round: string | null } | null;
  /** Display labels aligned with `battle.communities`; absent from older services. */
  labels?: Array<TokenLabel | null>;
}
export type LifecycleEnvelope = ApplicationEnvelope<LifecycleDetail>;

export class LifecycleReadError extends Error {
  constructor(message: string, readonly status: number | null) { super(message); }
}

/** Reads one battle through the versioned route. A failure is an error, never a mock or a legacy lookup. */
export async function fetchLifecycleBattle(namespace: Namespace, battleId: string, signal: AbortSignal,
  doFetch?: Parameters<typeof fetchApplication>[4]): Promise<LifecycleEnvelope> {
  if (!/^[1-9][0-9]{0,19}$/.test(battleId)) throw new LifecycleReadError("invalid battle id", 400);
  const res = await fetchApplication<LifecycleDetail>(namespace, `battles/${battleId}`, {}, signal, doFetch).catch((e: Error) => {
    throw new LifecycleReadError(e.message, null);
  });
  if (res.data?.battleId !== battleId) throw new LifecycleReadError("response is for another battle", null);
  return res;
}

export type RoundPhase =
  | { kind: "not_started" }
  | { kind: "awaiting_open"; candidates: number[] }
  | { kind: "window_open"; msLeft: number; candidates: number[] }
  /** The recorded end has passed. This is NOT a result: the contract's resolution decides. */
  | { kind: "awaiting_resolution"; candidates: number[] }
  | { kind: "decided"; winner: number };

/** Where the recorded round is. The clock only moves between window_open and awaiting_resolution; it never picks a winner. */
export function roundPhase(round: LifecycleRound | null, nowMs: number): RoundPhase {
  if (!round) return { kind: "not_started" };
  if (round.winner !== null) return { kind: "decided", winner: round.winner };
  if (!round.start_ns || !round.end_ns) return { kind: "awaiting_open", candidates: round.candidates };
  const endMs = Number(BigInt(round.end_ns) / 1_000_000n);
  if (nowMs <= 0) return { kind: "window_open", msLeft: 0, candidates: round.candidates }; // clock not read yet (server render)
  // The oracle may open a window slightly ahead of now (it lands when the transaction does); never show more than the window length.
  const startMs = Number(BigInt(round.start_ns) / 1_000_000n);
  return nowMs < endMs ? { kind: "window_open", msLeft: Math.min(endMs - nowMs, endMs - startMs), candidates: round.candidates } : { kind: "awaiting_resolution", candidates: round.candidates };
}

export interface CommunityRow {
  index: number;
  representation: string;
  asset: string;
  vault: string;
  reference: string | null;
  label: TokenLabel | null;
  audit: { evidenceHash: string | null; expiresAtMs: string | null; state: "none" | "valid" | "expired" };
  backing: { known: boolean; trusted: boolean; assetMatches: boolean; fresh: boolean; expiresAtMs: string | null; evidenceHash: string | null };
  /** Specific reasons this community is not ready, or an empty list. Never inferred from a symbol or model. */
  blockers: string[];
  eliminated: boolean;
  recordedWinner: boolean;
}

/** Missing readiness is unknown, never evidence that approval is pending. */
export function communityApproval(row: CommunityRow): { label: string; approved: boolean } {
  if (!row.backing.known) return { label: "Approval status unavailable", approved: false };
  if (row.audit.state === "expired") return { label: "Approval expired", approved: false };
  if (row.audit.state === "valid" && row.backing.fresh && row.backing.trusted && row.backing.assetMatches)
    return { label: "Approved", approved: true };
  return { label: "Waiting for approval", approved: false };
}

export function communityRows(detail: LifecycleDetail, nowMs: number): CommunityRow[] {
  const candidates = detail.round && detail.round.winner === null ? new Set(detail.round.candidates) : null;
  return detail.battle.communities.map((c, index) => {
    const expiry = c.audit_expires_at_ms;
    const audit: CommunityRow["audit"] = {
      evidenceHash: c.audit_evidence_hash, expiresAtMs: expiry,
      state: !c.audit_evidence_hash ? "none" : expiry !== null && nowMs > 0 && BigInt(nowMs) >= BigInt(expiry) ? "expired" : "valid",
    };
    const b = detail.readiness?.backings?.find((x) => x.community === index);
    const backing: CommunityRow["backing"] = {
      known: !!b, trusted: b?.trusted ?? false, assetMatches: b?.asset_matches ?? false, fresh: b?.fresh ?? false,
      expiresAtMs: b?.expires_at_ms ?? null, evidenceHash: b?.evidence_hash ?? c.backing_evidence_hash,
    };
    const blockers: string[] = [];
    if (audit.state === "none") blockers.push("no audit approval recorded");
    else if (audit.state === "expired") blockers.push("audit approval expired");
    if (!b) blockers.push("backing readiness unavailable");
    else {
      if (!b.trusted) blockers.push("representation is not trusted");
      if (!b.asset_matches) blockers.push("backing approval is for another asset");
      if (!b.fresh) blockers.push("backing approval missing or expired");
    }
    return {
      index, representation: c.representation, asset: `${c.chain_id}:${c.token_address}`, vault: c.vault,
      reference: c.reference_chain_id !== null && c.reference_address !== null ? `${c.reference_chain_id}:${c.reference_address}` : null,
      label: detail.labels?.[index] ?? null,
      audit, backing, blockers,
      eliminated: candidates !== null && !candidates.has(index),
      recordedWinner: detail.round?.winner === index,
    };
  });
}

export function battleStatus(detail: LifecycleDetail): "open" | "locked" | "decided" | "cancelled" {
  if (detail.battle.cancelled === true) return "cancelled";
  if (!detail.battle.locked) return "open";
  return detail.round?.winner != null ? "decided" : "locked";
}

/** Reasons the whole arena cannot take actions right now, from the contract's own readiness view. */
export function arenaBlockers(r: LifecycleReadiness | null): string[] {
  if (!r) return ["lifecycle readiness unavailable"];
  const out: string[] = [];
  if (!r.activated) out.push(r.activation_blocked_by_legacy ? "lifecycle is not activated: legacy battles block activation" : "lifecycle is not activated");
  if (r.paused) out.push("the arena is paused");
  return out;
}

export const nsToMs = (ns: string): number => Number(BigInt(ns) / 1_000_000n);
