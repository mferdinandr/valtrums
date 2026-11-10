// FIXTURE-ONLY: synthetic observations. Not provider output and not live evidence.
import type { Observation } from "../../src/observations/schema.js";

export const NS = { deploymentId: "testnet-a", network: "near-testnet", arenaContract: "arena.testnet", protocol: "lifecycle-v2" } as const;
export const POLICY = "policy-hash-1";
export const START_MS = 1_000_000n;
export const END_MS = START_MS + 30_000n;
export const START_NS = (START_MS * 1_000_000n).toString();
export const END_NS = (END_MS * 1_000_000n).toString();

let counter = 0;
export function price(community: number, atMs: bigint | null, value: string, over: Partial<Observation> = {}): Observation {
  counter++;
  return {
    schema: "market-observation-v1",
    namespace: { ...NS },
    battleId: "1",
    roundId: "1",
    community,
    mode: "PriceGain",
    policyHash: POLICY,
    mappingVersion: "3",
    asset: { chainId: "46630", token: `0x${"aa".repeat(20)}` },
    reference: { chainId: "4663", token: `0x${"bb".repeat(20)}` },
    source: { name: "fixture-dex", pool: "pool-1", quote: "USD" },
    inputs: { kind: "price", price: value, priceScale: 8 },
    evidenceHash: `evidence-${community}-${atMs ?? "none"}-${value}-${counter}`,
    observedAtMs: atMs === null ? null : atMs.toString(),
    acquiredAtMs: (atMs ?? 0n).toString(),
    ...over,
  } as Observation;
}

export const frozen = (over: Record<string, unknown> = {}) => ({
  namespace: { ...NS },
  battleId: "1",
  roundId: "1",
  mode: "PriceGain" as const,
  policyHash: POLICY,
  candidates: [0, 1],
  startNs: START_NS,
  endNs: END_NS,
  boundaryToleranceMs: 1_000,
  maxGapMs: 12_000,
  ...over,
});
