import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Market observation evidence (OpenSpec arena-market-observations, issue #146). One record is one
 * accepted sample for one community of one round, bound to the full deployment namespace, the frozen
 * observation policy and mapping version, the actual source asset and its optional mainnet reference.
 * Integers are decimal strings checked against their bit width and never pass through a JS number.
 * Provider observation time is nullable: acquisition time is a separate field and is never relabeled
 * as observation time. There is deliberately no field for rolling 24h volume or FDV: they cannot
 * stand in for exact interval volume or circulating cap, and `.strict()` rejects them by name.
 */
export const OBSERVATION_SCHEMA = "market-observation-v1" as const;

export const MODES = ["PriceGain", "MarketCapGrowth", "VolumeRatio", "LowestDrawdown"] as const;
export type Mode = (typeof MODES)[number];

const uint = (bits: 64 | 128) =>
  z.string().regex(/^(0|[1-9][0-9]*)$/).max(39).refine((s) => BigInt(s) < 2n ** BigInt(bits), "integer out of range");
const posUint128 = uint(128).refine((s) => s !== "0", "must be positive");
const text = (max: number) => z.string().min(1).max(max);
const scale = z.number().int().min(0).max(36);
/** Lowercase 20-byte hex; checksum casing is normalized away before storage. */
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase());

export const namespaceSchema = z
  .object({
    deploymentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    network: z.enum(["near-testnet", "near-mainnet"]),
    arenaContract: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/).min(2).max(64),
    protocol: z.enum(["legacy-v1", "lifecycle-v2"]),
  })
  .strict();
export type ObservationNamespace = z.infer<typeof namespaceSchema>;

const identity = z.object({ chainId: uint(64), token: address }).strict();

const priceInput = z.object({ kind: z.literal("price"), price: posUint128, priceScale: scale }).strict();
const marketCapInput = z
  .object({ kind: z.literal("marketCap"), price: posUint128, priceScale: scale, circulatingSupply: posUint128, supplyScale: scale })
  .strict();
const volumeInput = z
  .object({
    kind: z.literal("volume"),
    /** Exact quote volume of deduplicated trades inside the frozen interval, not a rolling window. */
    intervalQuoteVolume: uint(128),
    tradeCount: uint(64),
    price: posUint128,
    priceScale: scale,
    circulatingSupply: posUint128,
    supplyScale: scale,
  })
  .strict();

const MODE_INPUT: Record<Mode, "price" | "marketCap" | "volume"> = {
  PriceGain: "price",
  LowestDrawdown: "price",
  MarketCapGrowth: "marketCap",
  VolumeRatio: "volume",
};

export const observationSchema = z
  .object({
    schema: z.literal(OBSERVATION_SCHEMA),
    namespace: namespaceSchema,
    battleId: uint(64).refine((s) => s !== "0"),
    roundId: uint(64).refine((s) => s !== "0"),
    community: z.number().int().min(0).max(15),
    mode: z.enum(MODES),
    policyHash: text(128),
    mappingVersion: uint(64),
    asset: identity,
    reference: identity.nullable(),
    source: z.object({ name: text(64), pool: text(128).nullable(), quote: text(32) }).strict(),
    inputs: z.discriminatedUnion("kind", [priceInput, marketCapInput, volumeInput]),
    evidenceHash: text(128),
    /** Provider observation time (ms), or null when the provider gives none. */
    observedAtMs: uint(64).nullable(),
    /** When this process acquired the sample (ms). Never substituted for `observedAtMs`. */
    acquiredAtMs: uint(64),
  })
  .strict()
  .superRefine((o, ctx) => {
    if (o.inputs.kind !== MODE_INPUT[o.mode]) {
      ctx.addIssue({ code: "custom", message: `mode ${o.mode} needs ${MODE_INPUT[o.mode]} inputs` });
    }
  });
export type Observation = z.infer<typeof observationSchema>;

export const retractionSchema = z
  .object({
    namespace: namespaceSchema,
    observationId: z.string().regex(/^[0-9a-f]{64}$/),
    reason: text(256),
    acquiredAtMs: uint(64),
  })
  .strict();
export type Retraction = z.infer<typeof retractionSchema>;

function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}
export const canonicalJson = canonical;
export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Content identity: everything except the acquisition time, so a late retry of the same sample is the same record. */
export function observationId(o: Observation): string {
  const { acquiredAtMs: _acquired, ...content } = o;
  return sha256Hex(canonical(content));
}

/** Source slot: one evidence record per source for a community/round. Same slot with different content is a conflict. */
export function slotKey(o: Observation): string {
  return canonical([o.namespace, o.battleId, o.roundId, o.community, o.source.name, o.evidenceHash]);
}

export const namespaceKey = (n: ObservationNamespace): string => canonical([n.deploymentId, n.network, n.arenaContract, n.protocol]);
