import { z } from "zod";

const u64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine((s) => BigInt(s) < 2n ** 64n);
const index = z.string().regex(/^(?:[0-9]|1[0-5])$/);
const candidates = z.array(index).min(1).max(16).refine((a) => new Set(a).size === a.length);
const text = z.string().min(1).max(256);
const numerator = z.string().regex(/^-?(0|[1-9][0-9]{0,77})$/)
  .refine((s) => s !== "-0" && BigInt(s.startsWith("-") ? s.slice(1) : s) < 2n ** 256n);
const denominator = z.string().regex(/^[1-9][0-9]{0,77}$/).refine((s) => BigInt(s) < 2n ** 256n);
export const roundEvidenceSchema = z.object({
  roundId: u64, protocol: z.literal("lifecycle-v2"), candidates,
  startNs: u64, endNs: u64, policyHash: text,
  outcome: z.discriminatedUnion("type", [
    z.object({ type: z.literal("pending"), reason: text }).strict(),
    z.object({ type: z.literal("overtime"), nextCandidates: candidates }).strict(),
    z.object({ type: z.literal("winner"), community: index }).strict(),
  ]).nullable(),
  scores: z.array(z.object({ community: index, numerator, denominator, evidenceHash: text }).strict()).max(16).nullable(),
}).strict().superRefine((r, ctx) => {
  if (BigInt(r.endNs) - BigInt(r.startNs) !== 30_000_000_000n) ctx.addIssue({ code: "custom", message: "invalid round window" });
  if (r.scores && (r.scores.length !== r.candidates.length || new Set(r.scores.map((s) => s.community)).size !== r.candidates.length || r.scores.some((s) => !r.candidates.includes(s.community)))) ctx.addIssue({ code: "custom", message: "score candidate mismatch" });
  if (r.outcome?.type === "winner" && !r.candidates.includes(r.outcome.community)) ctx.addIssue({ code: "custom", message: "foreign winner" });
  if (r.outcome?.type === "overtime" && (r.outcome.nextCandidates.length < 2 || r.outcome.nextCandidates.some((c) => !r.candidates.includes(c)))) ctx.addIssue({ code: "custom", message: "foreign overtime candidate" });
});
export type RoundEvidenceV1 = z.infer<typeof roundEvidenceSchema>;
export type RoundEventName = "lifecycle_round_opened_v1" | "lifecycle_round_pending_v1" | "lifecycle_round_resolved_v1";

/** Rust enum wire format, parsed losslessly by the existing parser before this function. */
export function normalizeRoundEvent(name: RoundEventName, data: unknown): RoundEvidenceV1 {
  const d = JSON.parse(JSON.stringify(data, (_key, value) => typeof value === "bigint" ? String(value) : value));
  const outcome = d.outcome?.Pending ? { type: "pending", reason: d.outcome.Pending.reason }
    : d.outcome?.Overtime ? { type: "overtime", nextCandidates: d.outcome.Overtime.next_candidates }
      : d.outcome?.Winner ? { type: "winner", community: d.outcome.Winner.community } : null;
  const round = roundEvidenceSchema.parse({ roundId: d.round_id, protocol: d.protocol, candidates: d.candidates,
    startNs: d.start_ns, endNs: d.end_ns, policyHash: d.policy_hash, outcome,
    scores: d.scores?.map((s: Record<string, unknown>) => ({ community: s.community, numerator: s.numerator, denominator: s.denominator, evidenceHash: s.evidence_hash })) ?? null });
  if (name === "lifecycle_round_opened_v1" && (round.outcome !== null || round.scores !== null)) throw new Error("invalid opened event");
  if (name === "lifecycle_round_pending_v1" && (round.outcome?.type !== "pending" || round.scores !== null)) throw new Error("invalid pending event");
  if (name === "lifecycle_round_resolved_v1" && (!round.outcome || round.outcome.type === "pending" || !round.scores)) throw new Error("incomplete resolved event");
  return round;
}
