import { describe, expect, it } from "vitest";
import { buildCreateReview, CREATE_DEPOSIT_YOCTO, type AssetDraft } from "./create-review";

const asset = (i: number, over: Partial<AssetDraft> = {}): AssetDraft => ({
  chainId: "46630", tokenAddress: `0x${String(i).repeat(40)}`, representation: `c${i}.rep.testnet`, custodyDomain: "custody-v1", referenceChainId: "", referenceAddress: "", ...over,
});
const ok = (assets: AssetDraft[], mode = "PriceGain") => buildCreateReview("arena.testnet", assets, mode);

describe("create_lifecycle_battle review", () => {
  it("builds the exact wire arguments the agent preview builds, for two and three communities", () => {
    for (const n of [2, 3]) {
      const r = ok(Array.from({ length: n }, (_, i) => asset(i + 1)));
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.method).toBe("create_lifecycle_battle");
      expect(r.receiver).toBe("arena.testnet");
      expect(Object.keys(r.args)).toEqual(["assets", "mode"]); // no bond, no duration, no usdc
      expect(r.args.assets).toHaveLength(n);
      expect(Object.keys(r.args.assets[0]!)).toEqual(["chain_id", "token_address", "representation", "custody_domain", "reference_chain_id", "reference_address"]);
      expect(r.args.assets[0]).toMatchObject({ reference_chain_id: null, reference_address: null });
      expect(r.depositYocto).toBe(CREATE_DEPOSIT_YOCTO);
    }
  });

  it("keeps a reference as an identity pair and discloses it", () => {
    const r = ok([asset(1, { referenceChainId: "4663", referenceAddress: `0x${"bb".repeat(20)}` }), asset(2)]);
    expect(r.ok && r.args.assets[0]).toMatchObject({ reference_chain_id: "4663", reference_address: `0x${"bb".repeat(20)}` });
    expect(r.ok && r.lines.some((l) => l.value.includes(`reference 4663:0x${"bb".repeat(20)}`))).toBe(true);
    expect(r.ok && r.lines.some((l) => l.value.includes("no reference"))).toBe(true);
  });

  it("refuses too few or too many communities, a missing mode and an unconfigured arena", () => {
    expect(ok([asset(1)])).toEqual({ ok: false, problems: ["a battle needs at least 2 communities"] });
    expect(ok(Array.from({ length: 17 }, (_, i) => asset(i % 9 + 1, { chainId: String(i + 1) }))).ok).toBe(false);
    expect((ok([asset(1), asset(2)], "") as { problems: string[] }).problems).toContain("choose a scoring mode");
    expect((buildCreateReview("", [asset(1), asset(2)], "PriceGain") as { problems: string[] }).problems).toContain("the arena contract id is not configured");
  });

  it("rejects malformed identity instead of normalizing it away", () => {
    const bad = ok([asset(1, { chainId: "46630.5", tokenAddress: "0x1234", representation: "Bad Account", custodyDomain: " " }), asset(2)]);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problems).toEqual([
      "community 1: chain id must be a decimal integer",
      "community 1: token address must be a 20-byte hex address",
      "community 1: representation must be a valid NEAR account id",
      "community 1: custody domain is required (at most 64 characters)",
    ]);
    expect(ok([asset(1, { chainId: "18446744073709551616" }), asset(2)]).ok).toBe(false); // above u64
  });

  it("requires both halves of a reference, and rejects duplicates", () => {
    expect((ok([asset(1, { referenceChainId: "4663" }), asset(2)]) as { problems: string[] }).problems).toContain("community 1: a reference needs both its chain id and its address");
    const dup = ok([asset(1), asset(1)]) as { problems: string[] };
    expect(dup.problems).toEqual(expect.arrayContaining(["community 2: the same asset is listed twice", "community 2: the same representation is listed twice"]));
  });

  it("says the deposit is storage, not stake, and that there is no bond or duration", () => {
    const r = ok([asset(1), asset(2)]);
    expect(r.ok && r.notes.join(" ")).toMatch(/storage payment, not a stake/);
    expect(r.ok && r.notes.join(" ")).toMatch(/no bond and no round duration/);
  });
});
