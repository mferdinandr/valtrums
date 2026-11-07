// FIXTURE-ONLY: mapping and GoPlus responses are synthetic. Not live evidence.
import { describe, expect, it } from "vitest";
import { approvalStatus, refreshBattleAudit, AuditSubmitter, type RefreshDeps } from "../../src/audit/approval.js";
import { evaluateCommunity, goplusTarget, type AuditAsset } from "../../src/audit/decision.js";
import type { LpEvidence } from "../../src/audit/liquidity.js";
import { resolveReference, validateRegistry } from "../../src/audit/reference.js";
import { CHAIN, FIXTURE_RESOLVED, NOW, REF_CHAIN, REF_TOKEN, TOKEN, asset, goplus, lp, refGoplus, refLp, registry } from "./fixtures.js";

const mapped = (): AuditAsset => {
  const r = resolveReference(asset, registry);
  if (r.kind !== "mapped") throw new Error("expected mapping");
  return { ...asset, reference: r.reference };
};

const evalWith = (
  a: AuditAsset,
  g: ReturnType<typeof goplus> | null,
  l: LpEvidence | null = a.reference ? refLp("10001") : lp("10001"),
) => evaluateCommunity({ asset: a, goplus: g, lp: l, policy: FIXTURE_RESOLVED, now: NOW });

describe("reference-token audit (fixture-only)", () => {
  it("resolves only from the registry; self-declared or conflicting mappings hold", () => {
    expect(resolveReference(asset, registry).kind).toBe("mapped");
    expect(resolveReference(asset, [], { referenceChainId: REF_CHAIN, referenceAddress: REF_TOKEN })).toMatchObject({
      kind: "hold",
      code: "reference_unregistered",
    });
    expect(resolveReference(asset, registry, { referenceChainId: REF_CHAIN, referenceAddress: TOKEN })).toMatchObject({
      kind: "hold",
      code: "reference_conflict",
    });
    expect(
      resolveReference(asset, registry, { referenceChainId: REF_CHAIN, referenceAddress: REF_TOKEN }).kind,
    ).toBe("mapped");
    expect(resolveReference(asset, []).kind).toBe("direct");
  });

  it("validates registry entries", () => {
    expect(() => validateRegistry([{ ...registry[0]!, referenceChainId: "1" }])).toThrow();
    expect(() => validateRegistry([{ ...registry[0]!, token: "nope" }])).toThrow();
    expect(() => validateRegistry([registry[0]!, registry[0]!])).toThrow();
    expect(validateRegistry(registry)).toHaveLength(1);
  });

  it("passes with mainnet reference evidence and labels the record as a reference-token audit", () => {
    const a = mapped();
    expect(goplusTarget(a)).toEqual({ chainId: REF_CHAIN, token: REF_TOKEN });
    const r = evalWith(a, refGoplus());
    expect(r.result).toBe("pass");
    expect(r.auditKind).toBe("reference_token");
    expect(r.asset.chainId).toBe(CHAIN);
    expect(r.asset.reference?.chainId).toBe(REF_CHAIN);
    expect(r.evidenceSubject).toEqual({
      chainId: REF_CHAIN,
      token: REF_TOKEN,
      covers: ["goplus", "lp"],
      assetItselfAudited: false,
    });
  });

  it("liquidity evidence for the testnet mock cannot satisfy a mapped asset; only the reference token's can", () => {
    const g = refGoplus();
    expect(evalWith(mapped(), g, lp("50000")).result).toBe("pending");
    expect(evalWith(mapped(), g, refLp("10000")).result).toBe("pending");
    expect(evalWith(mapped(), g, refLp("10001")).result).toBe("pass");
    expect(evalWith(mapped(), g, null).result).toBe("pending");
    expect(evalWith(asset, goplus()).evidenceSubject.assetItselfAudited).toBe(true);
  });

  it("the evidence hash commits to the evidence subject", () => {
    const a = evalWith(mapped(), refGoplus());
    const b = evalWith(mapped(), refGoplus(), refLp("10002"));
    expect(a.evidenceHash).not.toBe(b.evidenceHash);
  });

  it("evidence hash differs between a reference and a direct audit of the same asset", () => {
    const ref = evalWith(mapped(), refGoplus());
    const direct = evalWith(asset, goplus());
    expect(ref.evidenceHash).not.toBe(direct.evidenceHash);
    expect(direct.auditKind).toBe("direct");
  });

  it("evidence for the testnet token itself or another token cannot satisfy a mapped asset", () => {
    for (const g of [goplus(), goplus({}, { chainId: REF_CHAIN, queryToken: TOKEN })]) {
      const r = evalWith(mapped(), g);
      expect(r.result).toBe("pending");
      expect(r.reasons.some((x) => x.code === "wrong_source")).toBe(true);
    }
  });

  it("unmapped tokens keep the direct rule: reference evidence cannot approve them", () => {
    expect(evalWith(asset, refGoplus()).result).toBe("pending");
  });

  it("a hold keeps the record pending without a provider query", () => {
    const r = evaluateCommunity({
      asset,
      goplus: null,
      lp: lp("10001"),
      policy: FIXTURE_RESOLVED,
      now: NOW,
      referenceHold: { code: "reference_unregistered", message: "unregistered" },
    });
    expect(r.result).toBe("pending");
    expect(r.reasons[0]?.code).toBe("reference_unregistered");
  });

  it("a mapping change invalidates an earlier approval", () => {
    const r = evalWith(mapped(), refGoplus());
    expect(approvalStatus(r, mapped(), FIXTURE_RESOLVED, NOW)).toEqual({ valid: true });
    const other = resolveReference(asset, [
      { ...registry[0]!, referenceToken: "0x00000000000000000000000000000000000000dd" },
    ]);
    if (other.kind !== "mapped") throw new Error("expected mapping");
    expect(approvalStatus(r, { ...asset, reference: other.reference }, FIXTURE_RESOLVED, NOW)).toMatchObject({
      reason: "asset_changed",
    });
    expect(approvalStatus(r, asset, FIXTURE_RESOLVED, NOW)).toMatchObject({ reason: "asset_changed" });
  });

  it("refresh queries GoPlus for the reference pair and never queries when the mapping is held", async () => {
    const queries: { chainId: string; token: string }[] = [];
    const calls: unknown[][] = [];
    const base: RefreshDeps = {
      policy: FIXTURE_RESOLVED,
      registry,
      now: () => NOW,
      fetchGoPlus: async (q) => {
        queries.push(q);
        return refGoplus();
      },
      fetchLp: async () => refLp("10001"),
      submitter: new AuditSubmitter("arena.testnet", { call: async (...a: unknown[]) => void calls.push(a) } as never),
      records: new Map(),
      isLocked: async () => false,
    };
    const ok = await refreshBattleAudit(1, [asset], base);
    expect(ok.ready).toBe(true);
    expect(queries).toEqual([{ chainId: REF_CHAIN, token: REF_TOKEN }]);

    queries.length = 0;
    const held = await refreshBattleAudit(2, [asset], {
      ...base,
      registry: [],
      records: new Map(),
      declaredReference: () => ({ referenceChainId: REF_CHAIN, referenceAddress: REF_TOKEN }),
    });
    expect(held.ready).toBe(false);
    expect(queries).toHaveLength(0);
    expect((calls[1]![2] as { result: string }).result).toBe("pending");
  });
});
