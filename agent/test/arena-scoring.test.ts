import { describe, expect, it } from "vitest";
import {
  ROUND_DURATION_NS, compareRationals, evaluateRound, marketCapGrowth, maximumDrawdown,
  priceGain, rational, volumeToInitialMarketCap,
  type CandidateEvidence, type ObservationProvenance, type RoundScoringInput,
  type ScoringMode, type TradeObservation, type ValueObservation,
} from "../src/arena-scoring.js";

const second = 1_000_000_000n;
const start = 100n * second;
const end = start + ROUND_DURATION_NS;
const address = (id: number) => `0x${id.toString(16).padStart(40, "0")}`;
function input(mode: ScoringMode = "PricePercentGain", names = ["A", "B"]): RoundScoringInput {
  return {
    nowNs: end + 1_000n * second,
    policy: {
      id: "policy-hash-v1", quoteCurrency: "USD", priceSourceId: "prices", supplySourceId: "circulating",
      volumeSourceId: "trades", boundaryToleranceNs: 0n, maxPriceGapNs: 10n * second,
      maxPublicationLagNs: 60n * second,
      eligiblePoolsByCommunity: Object.fromEntries(names.map((name) => [name, [`pool-${name}`]])),
    },
    round: {
      battleId: "battle-17", index: 0n, startNs: start, endNs: end, mode,
      policyId: "policy-hash-v1", originalCommunities: names.map((communityId, i) => ({
        communityId, asset: { chainId: "46630", tokenAddress: address(i + 1) },
      })), candidates: names,
    },
    evidence: [],
  };
}
function provenance(base: RoundScoringInput, id: string, time: bigint, sourceId = "prices"): ObservationProvenance {
  return {
    battleId: base.round.battleId, roundIndex: base.round.index, policyId: base.policy.id,
    asset: base.round.originalCommunities.find((candidate) => candidate.communityId === id)!.asset,
    sourceId, blockHash: `block-${time}`, observedAtNs: time, publishedAtNs: time,
    finalized: true, fixture: true,
  };
}
function value(base: RoundScoringInput, id: string, time: bigint, amount: bigint, source = "prices"): ValueObservation {
  return { provenance: provenance(base, id, time, source), value: rational(amount) };
}
function prices(base: RoundScoringInput, id: string, amounts: bigint[]): CandidateEvidence {
  return {
    communityId: id,
    prices: amounts.map((amount, i) => value(base, id,
      base.round.startNs + BigInt(i) * ROUND_DURATION_NS / BigInt(amounts.length - 1), amount)),
  };
}
function trade(base: RoundScoringInput, id: string, time: bigint, amount: bigint, logIndex = 0n): TradeObservation {
  return {
    provenance: provenance(base, id, time, "trades"), txHash: `0x${"a".repeat(64)}`, logIndex,
    poolId: `pool-${id}`, quoteVolumeUsd: rational(amount),
  };
}
function volume(base: RoundScoringInput, id: string, trades: TradeObservation[], complete = true): CandidateEvidence {
  return {
    ...prices(base, id, [10n, 10n]),
    circulatingSupplyStart: value(base, id, base.round.startNs, 100n, "circulating"),
    volume: {
      provenance: provenance(base, id, base.round.endNs, "trades"), startNs: base.round.startNs,
      endNs: base.round.endNs, complete, eligiblePools: [`pool-${id}`], trades,
    },
  };
}
function reason(result: ReturnType<typeof evaluateRound>): string {
  expect(result.status).toBe("Pending");
  return result.status === "Pending" ? result.issues.map((issue) => issue.reason).join(" ") : "";
}

describe("exact mode arithmetic", () => {
  it("retains negative gains and exact rational equality", () => {
    expect(priceGain(rational(100n), rational(95n))).toEqual(rational(-1n, 20n));
    expect(compareRationals(rational(-1n, 20n), rational(-1n, 10n))).toBe(1);
    expect(compareRationals(rational(1n, 3n), rational(2n, 6n))).toBe(0);
  });
  it("does not tie different scores that round to the same displayed value", () => {
    const huge = 10n ** 100n;
    expect(compareRationals(priceGain(rational(huge), rational(huge + 1n)), rational(0n))).toBe(1);
  });
  it("uses circulating supply at both market-cap endpoints", () => {
    expect(marketCapGrowth(rational(2n), rational(1000n), rational(22n, 10n), rational(900n)))
      .toEqual(rational(-1n, 100n));
  });
  it("matches price growth when circulating supply stays constant", () => {
    expect(marketCapGrowth(rational(2n), rational(1000n), rational(3n), rational(1000n)))
      .toEqual(priceGain(rational(2n), rational(3n)));
  });
  it("normalizes unlike decimal scales without floating point", () => {
    expect(priceGain(rational(200n, 100n), rational(2200n, 1000n))).toEqual(rational(1n, 10n));
    expect(volumeToInitialMarketCap(rational(30000n, 100n), rational(10n), rational(100n)))
      .toEqual(rational(3n, 10n));
  });
  it("tracks the interim peak rather than the starting or closing price", () => {
    expect(maximumDrawdown([100n, 120n, 90n, 110n].map((n) => rational(n)))).toEqual(rational(1n, 4n));
    expect(maximumDrawdown([100n, 95n, 105n, 100n].map((n) => rational(n)))).toEqual(rational(1n, 20n));
  });
  it("permits complete zero volume and nondecreasing zero drawdown", () => {
    expect(maximumDrawdown([100n, 100n, 110n].map((n) => rational(n)))).toEqual(rational(0n));
    expect(volumeToInitialMarketCap(rational(0n), rational(5n), rational(20n))).toEqual(rational(0n));
  });
  it("rejects invalid denominator, prices, supply and negative volume", () => {
    expect(() => rational(1n, 0n)).toThrow();
    expect(() => priceGain(rational(0n), rational(1n))).toThrow();
    expect(() => priceGain(rational(1n), rational(-1n))).toThrow();
    expect(() => marketCapGrowth(rational(1n), rational(0n), rational(2n), rational(2n))).toThrow();
    expect(() => volumeToInitialMarketCap(rational(-1n), rational(1n), rational(1n))).toThrow();
    expect(() => maximumDrawdown([rational(1n)])).toThrow();
  });
});

describe("frozen intervals and observation evidence", () => {
  it("chooses the least negative gain among three candidates, even if the scheduler is late", () => {
    const base = input("PricePercentGain", ["A", "B", "C"]);
    const result = evaluateRound({ ...base, evidence: [prices(base, "A", [100n, 95n]),
      prices(base, "B", [100n, 90n]), prices(base, "C", [100n, 80n])] });
    expect(result).toMatchObject({ status: "Winner", winnerId: "A" });
  });
  it("uses supply data to choose market-cap growth instead of price gain", () => {
    const base = input("MarketCapPercentGrowth");
    const a = { ...prices(base, "A", [20n, 22n]),
      circulatingSupplyStart: value(base, "A", start, 1000n, "circulating"),
      circulatingSupplyEnd: value(base, "A", end, 900n, "circulating") };
    const b = { ...prices(base, "B", [10n, 10n]),
      circulatingSupplyStart: value(base, "B", start, 2000n, "circulating"),
      circulatingSupplyEnd: value(base, "B", end, 2100n, "circulating") };
    expect(evaluateRound({ ...base, evidence: [a, b] })).toMatchObject({ status: "Winner", winnerId: "B" });
    expect(reason(evaluateRound({ ...base, evidence: [a, { ...b, circulatingSupplyEnd: undefined }] })))
      .toContain("missing required endpoint");
  });
  it("requires exactly thirty seconds and refuses resolution before the recorded close", () => {
    const base = input();
    expect(reason(evaluateRound({ ...base, round: { ...base.round, endNs: end + 1n } }))).toContain("30 seconds");
    expect(reason(evaluateRound({ ...base, nowNs: end - 1n }))).toContain("not ended");
  });
  it("does not replace a historical closing price with a current price", () => {
    const base = input();
    const late = { ...prices(base, "A", [100n, 110n]), prices: [value(base, "A", start, 100n), value(base, "A", end + second, 110n)] };
    expect(reason(evaluateRound({ ...base, evidence: [late, prices(base, "B", [100n, 105n])] })))
      .toContain("outside recorded interval");
  });
  it("does not synthesize a missing candidate or duplicate evidence", () => {
    const base = input(); const a = prices(base, "A", [100n, 110n]);
    expect(reason(evaluateRound({ ...base, evidence: [a] }))).toContain("missing candidate");
    expect(reason(evaluateRound({ ...base, evidence: [a, a] }))).toContain("duplicate candidate");
  });
  it.each(["sourceId", "policyId", "battleId", "blockHash"] as const)("refuses mismatched or empty %s", (field) => {
    const base = input(); const a = prices(base, "A", [100n, 110n]);
    const bad = { ...a, prices: a.prices!.map((p) => ({ ...p, provenance: { ...p.provenance, [field]: field === "blockHash" ? "" : "wrong" } })) };
    expect(evaluateRound({ ...base, evidence: [bad, prices(base, "B", [100n, 100n])] }).status).toBe("Pending");
  });
  it("refuses evidence from another chain/token/round", () => {
    const base = input();
    for (const patch of [
      { asset: { chainId: "4663", tokenAddress: address(1) } },
      { asset: { chainId: "46630", tokenAddress: address(9) } }, { roundIndex: 1n },
    ]) {
      const a = prices(base, "A", [100n, 110n]);
      const bad = { ...a, prices: a.prices!.map((p) => ({ ...p, provenance: { ...p.provenance, ...patch } })) };
      expect(evaluateRound({ ...base, evidence: [bad, prices(base, "B", [100n, 100n])] }).status).toBe("Pending");
    }
  });
  it("requires finalized evidence and bounded publication delay", () => {
    const base = input(); const a = prices(base, "A", [100n, 110n]);
    for (const patch of [{ finalized: false }, { publishedAtNs: end + 90n * second }]) {
      const bad = { ...a, prices: a.prices!.map((p) => ({ ...p, provenance: { ...p.provenance, ...patch } })) };
      expect(evaluateRound({ ...base, evidence: [bad, prices(base, "B", [100n, 100n])] }).status).toBe("Pending");
    }
  });
  it("preserves explicit fixture labels rather than presenting fixtures as provider evidence", () => {
    const base = input();
    const result = evaluateRound({ ...base, evidence: [prices(base, "A", [100n, 110n]), prices(base, "B", [100n, 100n])] });
    expect(result.status).toBe("Winner");
    if (result.status !== "Pending") expect(result.scores.every((s) => s.evidenceKind === "fixture")).toBe(true);
  });
  it("rejects duplicate source assets under different community names", () => {
    const base = input();
    const communities = base.round.originalCommunities.map((c) => ({ ...c, asset: base.round.originalCommunities[0]!.asset }));
    expect(reason(evaluateRound({ ...base, round: { ...base.round, originalCommunities: communities } })))
      .toContain("duplicate community source asset");
  });
});

describe("sampled drawdown", () => {
  it("chooses the lower maximum drawdown and accepts fully observed zero drawdown ties", () => {
    const base = input("LowestMaximumDrawdown");
    expect(evaluateRound({ ...base, evidence: [prices(base, "A", [100n, 120n, 90n, 110n]), prices(base, "B", [100n, 95n, 105n, 100n])] }))
      .toMatchObject({ status: "Winner", winnerId: "B" });
    expect(evaluateRound({ ...base, evidence: [prices(base, "A", [100n, 101n, 102n, 103n]), prices(base, "B", [5n, 5n, 6n, 7n])] }))
      .toMatchObject({ status: "Overtime" });
  });
  it("does not label missing intermediate prices as zero drawdown", () => {
    const base = input("LowestMaximumDrawdown");
    expect(reason(evaluateRound({ ...base, evidence: [prices(base, "A", [100n, 110n]), prices(base, "B", [100n, 101n, 102n, 103n])] })))
      .toContain("incomplete drawdown");
  });
  it("rejects duplicate and out-of-order sampled timestamps", () => {
    const base = input("LowestMaximumDrawdown");
    const a = prices(base, "A", [100n, 120n, 90n, 110n]);
    for (const points of [[a.prices![0]!, a.prices![0]!, a.prices![3]!], [...a.prices!].reverse()]) {
      expect(reason(evaluateRound({ ...base, evidence: [{ ...a, prices: points }, prices(base, "B", [100n, 101n, 102n, 103n])] })))
        .toContain("out-of-order");
    }
  });
});

describe("round quote-volume", () => {
  it("uses initial market cap and includes only [start,end) trades, deduplicating identical logs", () => {
    const base = input("VolumeToInitialMarketCap");
    const first = trade(base, "A", start, 300n);
    const a = volume(base, "A", [first, first, trade(base, "A", end, 10_000n, 1n)]);
    const b = { ...volume(base, "B", [trade(base, "B", start, 400n)]),
      circulatingSupplyStart: value(base, "B", start, 200n, "circulating") };
    const result = evaluateRound({ ...base, evidence: [a, b] });
    expect(result).toMatchObject({ status: "Winner", winnerId: "A" });
    if (result.status !== "Pending") expect(result.scores.map((s) => s.score)).toEqual([rational(3n, 10n), rational(1n, 5n)]);
  });
  it("does not require or validate unused ending market-cap observations", () => {
    const base = input("VolumeToInitialMarketCap");
    const a = volume(base, "A", [trade(base, "A", start, 300n)]);
    const badUnused = value(base, "A", end + 1_000n * second, -1n);
    expect(evaluateRound({ ...base, evidence: [{ ...a, prices: [a.prices![0]!, badUnused] }, volume(base, "B", [])] }))
      .toMatchObject({ status: "Winner", winnerId: "A" });
  });
  it("accepts a verified empty interval but not missing coverage", () => {
    const base = input("VolumeToInitialMarketCap");
    expect(evaluateRound({ ...base, evidence: [volume(base, "A", []), volume(base, "B", [])] }).status).toBe("Overtime");
    expect(reason(evaluateRound({ ...base, evidence: [volume(base, "A", [], false), volume(base, "B", [])] })))
      .toContain("complete volume coverage");
  });
  it("rejects conflicting duplicate logs rather than selecting one", () => {
    const base = input("VolumeToInitialMarketCap");
    expect(reason(evaluateRound({ ...base, evidence: [volume(base, "A", [trade(base, "A", start, 300n), trade(base, "A", start, 301n)]), volume(base, "B", [])] })))
      .toContain("conflicting duplicate");
  });
  it("rejects evidence-selected pools outside the frozen policy", () => {
    const base = input("VolumeToInitialMarketCap"); const a = volume(base, "A", []);
    expect(reason(evaluateRound({ ...base, evidence: [{ ...a, volume: { ...a.volume!, eligiblePools: ["manipulated-pool"] } }, volume(base, "B", [])] })))
      .toContain("frozen policy");
  });
  it("rejects rolling 24-hour or different interval volume evidence", () => {
    const base = input("VolumeToInitialMarketCap"); const a = volume(base, "A", []);
    expect(reason(evaluateRound({ ...base, evidence: [{ ...a, volume: { ...a.volume!, startNs: 0n } }, volume(base, "B", [])] })))
      .toContain("interval mismatch");
  });
});

describe("leader-only unlimited overtime", () => {
  it("resets rounds, preserves the original snapshot and never reintroduces eliminated candidates", () => {
    const base = input("PricePercentGain", ["A", "B", "C"]);
    const original = structuredClone(base.round.originalCommunities);
    const first = evaluateRound({ ...base, evidence: [prices(base, "A", [100n, 110n]), prices(base, "B", [200n, 220n]), prices(base, "C", [100n, 102n])] });
    expect(first.status).toBe("Overtime"); if (first.status !== "Overtime") return;
    expect(first.nextRound).toMatchObject({ index: 1n, candidates: ["A", "B"], startNs: end, endNs: end + ROUND_DURATION_NS });
    let next = first.nextRound;
    for (let i = 0; i < 20; i++) {
      const current = { ...base, round: next, nowNs: next.endNs + 1_000n * second };
      const tie = evaluateRound({ ...current, evidence: [prices(current, "A", [100n, 97n]), prices(current, "B", [200n, 194n])] });
      expect(tie.status).toBe("Overtime"); if (tie.status !== "Overtime") return;
      next = tie.nextRound;
    }
    const current = { ...base, round: next, nowNs: next.endNs + 1_000n * second };
    expect(evaluateRound({ ...current, evidence: [prices(current, "A", [100n, 96n]), prices(current, "B", [100n, 95n])] }))
      .toMatchObject({ status: "Winner", winnerId: "A" });
    expect(next.originalCommunities).toEqual(original);
    expect(next.candidates).toEqual(["A", "B"]);
    expect(reason(evaluateRound({ ...current, evidence: [prices(current, "A", [100n, 96n]), prices(current, "B", [100n, 95n]), prices(current, "C", [100n, 200n])] })))
      .toContain("eliminated candidate");
    expect(base.round.index).toBe(0n);
  });
  it("refuses stale prior-round evidence in a fresh overtime round", () => {
    const base = input(); const a = prices(base, "A", [100n, 110n]); const b = prices(base, "B", [100n, 110n]);
    const first = evaluateRound({ ...base, evidence: [a, b] });
    if (first.status !== "Overtime") throw new Error("expected tie");
    expect(reason(evaluateRound({ ...base, round: first.nextRound, nowNs: first.nextRound.endNs, evidence: [a, b] })))
      .toContain("mismatch");
  });
});
