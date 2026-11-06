import { createHash } from "node:crypto";
import {
  evaluateArenaAudit,
  type AuditAsset, type AuditDecision, type AuditPolicy, type ArenaAuditResult,
  type AuthorityEvidence, type DangerousPrivilege, type EvidenceOrigin,
  type GoPlusEvidence, type LiquidityDepthEvidence, type BoundEvidence,
} from "./arena-audit.js";

export type ArenaAuditStage = "Proposal" | "PreLock";
export interface AuditCommunitySnapshot {
  communityId: string;
  asset: AuditAsset;
  mappingVersion: string;
}
/** Dedicated target-arena wire view, deliberately independent of legacy A/B views. */
export interface ArenaAuditBattleSnapshot {
  battleId: string;
  version: string;
  status: "Proposed" | "Approved" | "Gathering" | "Locked" | "Live" | "Overtime" | "Settling" | "Settled" | "Voided";
  communities: AuditCommunitySnapshot[];
  policy: AuditPolicy;
  /** Authoritative chain clock and creator-selected deadline; neither is changed by a pass. */
  chainNowNs: string;
  gatheringDeadlineNs: string | null;
}
export interface StoredArenaAudit {
  stage: ArenaAuditStage;
  snapshotHash: string;
  idempotencyKey: string;
  decision: AuditDecision;
  evidenceMode: EvidenceOrigin;
  expiresAtMs: number;
}
export interface WireArenaTokenAudit extends Omit<ArenaAuditResult, "normalizedTaxes"> {
  normalizedTaxes: Record<string, { numerator: string; denominator: string } | null>;
  communityId: string;
  mappingVersion: string;
  evidenceHash: string;
}
export interface ArenaAuditSubmission extends StoredArenaAudit {
  battleId: string;
  expectedBattleVersion: string;
  policyVersion: string;
  collectedAtMs: number;
  communities: WireArenaTokenAudit[];
}
export interface TargetArenaAuditClient {
  getBattle(battleId: string): Promise<ArenaAuditBattleSnapshot | null>;
  /** Durable contract-side records, not a worker memory cache. */
  getAudit(battleId: string, stage: ArenaAuditStage): Promise<StoredArenaAudit | null>;
  /**
   * Must atomically validate expected battle version, mapping/policy snapshot,
   * allowed stage, and idempotency key before recording evidence. Returns Stale
   * if the battle changed or locked while external providers were running.
   */
  submitAudit(submission: ArenaAuditSubmission): Promise<"Recorded" | "Duplicate" | "Stale">;
}
export interface ArenaAuditProviders {
  goPlus: { audit(asset: AuditAsset): Promise<GoPlusEvidence> };
  liquidity: { getDepth(asset: AuditAsset): Promise<LiquidityDepthEvidence | null> };
  authority?: { getAuthority(asset: AuditAsset): Promise<Partial<Record<DangerousPrivilege, AuthorityEvidence>>> };
}
export interface ArenaAuditRunReport {
  battleId: string;
  action: "Recorded" | "Duplicate" | "Stale" | "Skipped";
  stage?: ArenaAuditStage;
  decision?: AuditDecision;
  submission?: ArenaAuditSubmission;
  reason?: string;
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function uint(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value) || value.length > 40) throw new Error("Invalid target-arena unsigned integer");
  return BigInt(value);
}
function decision(results: WireArenaTokenAudit[]): AuditDecision {
  return results.some(r => r.decision === "Reject") ? "Reject"
    : results.some(r => r.decision === "Pending") ? "Pending" : "Pass";
}
function unavailable(asset: AuditAsset, origin: EvidenceOrigin): GoPlusEvidence {
  return { ...asset, observedAtMs: 0, provider: "goplus-token-security-v1", origin,
    available: false, rawResponse: null, fields: null,
    responseHash: createHash("sha256").update("null").digest("hex"),
    unavailableReason: "Audit provider unavailable" };
}
function isBound(value: unknown): value is BoundEvidence {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.chainId === "string" && typeof v.tokenAddress === "string"
    && typeof v.observedAtMs === "number" && typeof v.provider === "string"
    && (v.origin === "live" || v.origin === "fixture");
}
function wire(result: ArenaAuditResult, community: AuditCommunitySnapshot, evidenceHash: string): WireArenaTokenAudit {
  return { ...result, communityId: community.communityId, mappingVersion: community.mappingVersion, evidenceHash,
    normalizedTaxes: Object.fromEntries(Object.entries(result.normalizedTaxes).map(([key, value]) => [key,
      value ? { numerator: value.numerator.toString(), denominator: value.denominator.toString() } : null])) };
}

/**
 * One injectable pre-lock pass. Does not start cron, lock rounds, mutate deadlines,
 * or expose any halt/refund method. New contract adapters must honor submitAudit's
 * atomic snapshot/version requirements before this is wired to a live scheduler.
 */
export async function runArenaAuditPass(options: {
  battleId: string;
  client: TargetArenaAuditClient;
  providers: ArenaAuditProviders;
  evidenceMode: EvidenceOrigin;
  nowMs?: () => number;
}): Promise<ArenaAuditRunReport> {
  const { client, providers, evidenceMode } = options;
  if (!["live", "fixture"].includes(evidenceMode)) throw new Error("Explicit live/fixture mode required");
  const nowMs = (options.nowMs ?? Date.now)();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid audit clock");
  const loaded = await client.getBattle(options.battleId);
  const battle = loaded ? structuredClone(loaded) : null;
  if (!battle) return { battleId: options.battleId, action: "Skipped", reason: "Battle not found" };
  if (battle.battleId !== options.battleId) throw new Error("Battle identity mismatch");
  if (!["Proposed", "Approved", "Gathering"].includes(battle.status)) {
    return { battleId: battle.battleId, action: "Skipped", reason: "Only proposal and pre-lock states may be audited" };
  }
  uint(battle.version);
  if (!battle.policy.version || !Number.isSafeInteger(battle.policy.maxEvidenceAgeMs) || battle.policy.maxEvidenceAgeMs < 1) {
    throw new Error("Invalid battle audit policy");
  }
  let stage: ArenaAuditStage = "Proposal";
  if (battle.status !== "Proposed") {
    if (battle.gatheringDeadlineNs === null) throw new Error("Approved battle lacks creator deadline");
    if (uint(battle.chainNowNs) < uint(battle.gatheringDeadlineNs)) {
      return { battleId: battle.battleId, action: "Skipped", reason: "Creator deadline has not elapsed on chain" };
    }
    stage = "PreLock";
  }
  const ids = new Set<string>(); const assets = new Set<string>();
  if (battle.communities.length < 2) throw new Error("At least two audited communities required");
  for (const community of battle.communities) {
    uint(community.mappingVersion);
    const asset = `${community.asset.chainId}:${community.asset.tokenAddress.toLowerCase()}`;
    if (!community.communityId || ids.has(community.communityId) || assets.has(asset)) throw new Error("Duplicate community or mapped asset");
    ids.add(community.communityId); assets.add(asset);
  }
  // Exclude the advancing clock from the snapshot, but include every immutable
  // identity, mapping, policy and deadline that the contract must compare.
  const snapshotHash = digest({ battleId: battle.battleId, version: battle.version,
    communities: battle.communities, policy: battle.policy, deadline: battle.gatheringDeadlineNs });
  const previous = await client.getAudit(battle.battleId, stage);
  if (previous?.stage === stage && previous.snapshotHash === snapshotHash && previous.evidenceMode === evidenceMode
    && previous.decision === "Pass" && Number.isSafeInteger(previous.expiresAtMs) && previous.expiresAtMs >= nowMs) {
    return { battleId: battle.battleId, stage, action: "Duplicate", decision: "Pass", reason: "Current durable audit remains fresh" };
  }
  const results = await Promise.all(battle.communities.map(async community => {
    const acquired = await Promise.allSettled([
      Promise.resolve().then(() => providers.goPlus.audit(community.asset)),
      Promise.resolve().then(() => providers.liquidity.getDepth(community.asset)),
      Promise.resolve().then(() => providers.authority?.getAuthority(community.asset)),
    ] as const);
    const g = acquired[0].status === "fulfilled" && isBound(acquired[0].value) && typeof acquired[0].value.responseHash === "string"
      ? acquired[0].value : unavailable(community.asset, evidenceMode);
    const lp = acquired[1].status === "fulfilled" && isBound(acquired[1].value) && Array.isArray(acquired[1].value.poolIds)
      ? acquired[1].value : null;
    const authorityRaw = acquired[2].status === "fulfilled" ? acquired[2].value : undefined;
    const authority = authorityRaw && typeof authorityRaw === "object"
      ? Object.fromEntries(Object.entries(authorityRaw).filter(([, value]) => isBound(value))) as Partial<Record<DangerousPrivilege, AuthorityEvidence>>
      : undefined;
    let evaluated: ArenaAuditResult;
    try {
      evaluated = evaluateArenaAudit({ asset: community.asset, goPlus: g, liquidity: lp, authority, policy: battle.policy, nowMs });
    } catch {
      evaluated = { asset: community.asset, policyVersion: battle.policy.version, decision: "Pending",
        findings: [{ field: "evidence", decision: "Pending", reason: "Malformed provider evidence" }],
        origins: [evidenceMode], normalizedFlags: {}, normalizedTaxes: {}, goPlusResponseHash: g.responseHash };
    }
    for (const [index, label] of ["goplus", "liquidity", "authority"].entries()) {
      if (acquired[index]?.status === "rejected") evaluated.findings.push({ field: label, decision: "Pending", reason: "Provider request failed" });
    }
    const usedOrigins = [g.origin, ...(lp ? [lp.origin] : []), ...Object.values(authority ?? {}).filter(a => a !== undefined).map(a => a.origin)];
    if (evidenceMode === "live" && usedOrigins.some(origin => origin !== "live")) {
      evaluated.findings.push({ field: "provenance", decision: "Pending", reason: "Fixture evidence cannot approve a live battle" });
    }
    evaluated.decision = evaluated.findings.some(f => f.decision === "Reject") ? "Reject"
      : evaluated.findings.some(f => f.decision === "Pending") ? "Pending" : "Pass";
    const timestamps = [g.observedAtMs, ...(lp ? [lp.observedAtMs] : []), ...Object.values(authority ?? {}).filter(a => a !== undefined).map(a => a.observedAtMs)];
    const validUntil = evaluated.decision === "Pass" ? Math.min(...timestamps) + battle.policy.maxEvidenceAgeMs : 0;
    const expiresAtMs = Number.isSafeInteger(validUntil) ? validUntil : 0;
    // Use provider evidence rather than the tick time to deduplicate unchanged
    // Pending/Reject reports across workers and restarts.
    return { result: wire(evaluated, community, digest({ goPlus: g, liquidity: lp, authority })), expiresAtMs };
  }));
  const communities = results.map(result => result.result);
  const overall = decision(communities);
  const expiresAtMs = overall === "Pass" ? Math.min(...results.map(r => r.expiresAtMs)) : 0;
  const idempotencyKey = digest({ battleId: battle.battleId, stage, snapshotHash, evidenceMode, communities, expiresAtMs });
  const submission: ArenaAuditSubmission = { battleId: battle.battleId, expectedBattleVersion: battle.version,
    stage, snapshotHash, idempotencyKey, decision: overall, evidenceMode, expiresAtMs,
    policyVersion: battle.policy.version, collectedAtMs: nowMs, communities };
  if (previous?.idempotencyKey === idempotencyKey) return { battleId: battle.battleId, stage, action: "Duplicate", decision: overall, submission };
  const action = await client.submitAudit(submission);
  return { battleId: battle.battleId, stage, action, decision: overall, submission };
}
