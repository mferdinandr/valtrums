import { z } from "zod";
import { integer, safeId } from "./application-contract.js";
import { UnsafeReadBoundaryError, type ArenaReadSource, type LifecycleBattleView, type RoundView } from "./read-source.js";
import { SCORING_MODES } from "./search.js";
import type { ViewFn } from "./read-source.js";

const u64 = z.unknown().transform((v, ctx) => {
  try { return integer(v); } catch { ctx.addIssue({ code: "custom", message: "unsafe u64" }); return z.NEVER; }
});
const u128 = z.unknown().transform((v, ctx) => {
  try { return integer(v, 128); } catch { ctx.addIssue({ code: "custom", message: "unsafe u128" }); return z.NEVER; }
});
const text = z.string().max(256);
const index = z.number().int().min(0).max(15);
export const battleSchema = z.object({
  creator: text, protocol: text, protocol_created: z.boolean(), fee_bps: z.number().int().min(0).max(10000),
  creator_share_bps: z.number().int().min(0).max(10000), mode: z.enum(SCORING_MODES), locked: z.boolean(),
  observation_policy_version: u64.nullable(), observation_policy_hash: text.nullable(),
  principal_community: index.nullable(), principal_amount: u128.nullable(),
  start_at_ms: u64.nullable().optional(), cancelled: z.boolean().optional(),
  communities: z.array(z.object({
    chain_id: u64, token_address: text, representation: text, custody_domain: text,
    reference_chain_id: u64.nullable(), reference_address: text.nullable(), vault: u128,
    audit_policy_hash: text.nullable(), audit_evidence_hash: text.nullable(), audit_expires_at_ms: u64.nullable(),
    backing_evidence_hash: text.nullable(),
  })).min(0).max(16),
});
export const roundSchema = z.object({
  round_id: u64, candidates: z.array(index).max(16), start_ns: u64.nullable(), end_ns: u64.nullable(), winner: index.nullable(),
});

const readinessSchema = z.object({
  schema_version: z.literal("lifecycle-application-v1"), block_height: u64, observed_at_ms: u64,
  activated: z.boolean(), paused: z.boolean(), legacy_battle_count: u64, activation_blocked_by_legacy: z.boolean(),
  protocol: text.nullable(), oracle: text.nullable(), audit_policy_hash: text.nullable(),
  observation_policy: z.object({ version: u64, policy_hash: text }).nullable(), battle_found: z.boolean().nullable(),
  backings: z.array(z.object({ community: index, representation: text, trusted: z.boolean(), asset_matches: z.boolean(),
    evidence_hash: text.nullable(), expires_at_ms: u64.nullable(), fresh: z.boolean() })).max(16).nullable(),
});
const historySchema = z.object({ items: z.array(z.object({ round_id: u64, outcome: z.unknown(), complete: z.literal(false),
  candidates: z.null(), start_ns: z.null(), end_ns: z.null(), scores: z.null(), reason: text })).max(50), next_round: u64.nullable() });

/** Explicitly opted-in ABI. MethodNotFound never falls back to a rounded legacy lookup. */
export class VersionedLifecycleReadSource {
  constructor(private readonly contract: string, private readonly view: ViewFn) {}
  async count() { return u64.parse(await this.view(this.contract, "get_lifecycle_battle_count_v1", {})); }
  async battle(id: string) {
    const raw = await this.view(this.contract, "get_lifecycle_battle_v1", { battle_id: integer(id) });
    return raw === null ? null : battleSchema.parse(raw);
  }
  async round(id: string) {
    const raw = await this.view(this.contract, "get_lifecycle_round", { battle_id: integer(id) });
    return raw === null ? null : roundSchema.parse(raw);
  }
  async readiness(id: string) {
    return readinessSchema.parse(await this.view(this.contract, "get_lifecycle_readiness_v1", { battle_id: integer(id) }));
  }
  async history(id: string) {
    const raw = await this.view(this.contract, "get_lifecycle_round_history_v1", { battle_id: integer(id), from_round: "1", limit: 20 });
    return raw === null ? null : historySchema.parse(raw);
  }
}

/** Reuses the exported ABI reader. The old bare-u64 battle argument remains deliberately bounded. */
export async function readApplicationBattle(source: ArenaReadSource, id: string): Promise<LifecycleBattleView | null> {
  const raw = await source.battle(safeId(id));
  if (raw === null) return null;
  const parsed = battleSchema.safeParse(raw);
  if (!parsed.success) throw new UnsafeReadBoundaryError("unsupported lifecycle battle boundary");
  return parsed.data;
}
export async function readApplicationRound(source: ArenaReadSource, id: string): Promise<RoundView | null> {
  const raw = await source.round(safeId(id));
  if (raw === null) return null;
  const parsed = roundSchema.safeParse(raw);
  if (!parsed.success) throw new UnsafeReadBoundaryError("unsupported lifecycle round boundary");
  return parsed.data;
}
