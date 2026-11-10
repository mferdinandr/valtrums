import { z } from "zod";
import { integer, safeId } from "./application-contract.js";
import { UnsafeReadBoundaryError, type ArenaReadSource, type LifecycleBattleView, type RoundView } from "./read-source.js";
import { SCORING_MODES } from "./search.js";

const u64 = z.unknown().transform((v, ctx) => {
  try { return integer(v); } catch { ctx.addIssue({ code: "custom", message: "unsafe u64" }); return z.NEVER; }
});
const u128 = z.unknown().transform((v, ctx) => {
  try { return integer(v, 128); } catch { ctx.addIssue({ code: "custom", message: "unsafe u128" }); return z.NEVER; }
});
const text = z.string().max(256);
const index = z.number().int().min(0).max(255);
export const battleSchema = z.object({
  creator: text, protocol: text, protocol_created: z.boolean(), fee_bps: z.number().int().min(0).max(10000),
  creator_share_bps: z.number().int().min(0).max(10000), mode: z.enum(SCORING_MODES), locked: z.boolean(),
  observation_policy_version: u64.nullable(), observation_policy_hash: text.nullable(),
  principal_community: index.nullable(), principal_amount: u128.nullable(),
  communities: z.array(z.object({
    chain_id: u64, token_address: text, representation: text, custody_domain: text,
    reference_chain_id: u64.nullable(), reference_address: text.nullable(), vault: u128,
    audit_policy_hash: text.nullable(), audit_evidence_hash: text.nullable(), audit_expires_at_ms: u64.nullable(),
    backing_evidence_hash: text.nullable(),
  })).min(2).max(256),
});
export const roundSchema = z.object({
  round_id: u64, candidates: z.array(index).max(256), start_ns: u64.nullable(), end_ns: u64.nullable(), winner: index.nullable(),
});

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
