import { z } from "zod";
import type { TokenLabel } from "../token-labels.js";

export const APPLICATION_SCHEMA = "arena-application-v1" as const;

/** Never stringify a rounded JSON number. Decimal strings are canonical and range checked. */
export function integer(value: unknown, bits: 64 | 128 = 64): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("unsafe integer boundary");
    value = String(value);
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 39 || BigInt(value) >= 2n ** BigInt(bits)) {
    throw new Error("invalid integer boundary");
  }
  return value;
}

export function safeId(value: unknown): number {
  const id = integer(value);
  if (id === "0" || BigInt(id) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("safe lifecycle ID view required (#144)");
  return Number(id);
}

const account = z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/).min(2).max(64);
const evidence = z.string().min(1).max(256);
const capability = z.object({ enabled: z.boolean(), reasons: z.array(evidence).min(1).max(10) }).strict();
export const deploymentSchema = z.object({
  deploymentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  network: z.enum(["near-testnet", "near-mainnet"]),
  arenaContract: account,
  protocol: z.enum(["legacy-v1", "lifecycle-v2"]),
  adapter: z.enum(["rpc", "fixture"]),
  companions: z.object({ payout: account.nullable(), registry: account.nullable(), backing: z.array(account).max(256) }).strict(),
  abi: z.object({ version: evidence, evidence, codeHash: evidence.nullable() }).strict(),
  capabilities: z.object({ battles: capability, detail: capability, assets: capability, audits: capability,
    /** Optional: a manifest written before market observations existed stays valid and reports it as not declared. */
    observations: capability.optional(),
    /** Optional: lifecycle oracle status in health. Absent means not declared. */
    oracle: capability.optional(),
    /** Optional: source-chain custody spendability gate in health (#148). Absent means not declared. */
    custody: capability.optional() }).strict(),
}).strict();
export const manifestSchema = z.array(deploymentSchema).max(32).superRefine((items, ctx) => {
  const ids = new Set<string>();
  for (const d of items) {
    if (ids.has(d.deploymentId)) ctx.addIssue({ code: "custom", message: "duplicate deployment ID" });
    ids.add(d.deploymentId);
  }
});
export type Deployment = z.infer<typeof deploymentSchema>;
export type Namespace = Pick<Deployment, "deploymentId" | "network" | "arenaContract" | "protocol">;
export type Capability = keyof Deployment["capabilities"];
export type ResolvedCapabilities = Record<Capability, { enabled: boolean; reasons: string[] }>;
export interface ApplicationEnvelope<T> {
  schemaVersion: typeof APPLICATION_SCHEMA;
  namespace: Namespace;
  provenance: {
    kind: "fixture" | "rpc" | "indexed" | "market" | "aggregate";
    fetchedAtMs: string;
    observedAtMs: string | null;
    readModelVersion: string | null;
    watermark: string | null;
    sourceReferences: string[];
    finality: "unknown" | "not-applicable";
    health: "healthy" | "degraded" | "unavailable";
    complete: boolean;
    reasons: string[];
  };
  data: T;
}

export const namespaceOf = (d: Deployment): Namespace => ({
  deploymentId: d.deploymentId, network: d.network, arenaContract: d.arenaContract, protocol: d.protocol,
});
export const namespaceKey = (n: Namespace): string => JSON.stringify([n.deploymentId, n.network, n.arenaContract, n.protocol]);

export interface ApplicationBattleSummary {
  battleId: string;
  creator: string;
  mode: string;
  status: "open" | "locked" | "decided";
  winner: number | null;
  communities: Array<{ index: number; representation: string; tokenAddress: string; chainId: string; /** Display name only; identity is chainId + tokenAddress. */ label: TokenLabel | null }>;
}
export interface ApplicationPage<T> { items: T[]; nextCursor: string | null; truncated: boolean }
