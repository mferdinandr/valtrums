import { describe, expect, it } from "vitest";
import { buildCreateReview, CREATE_DEPOSIT_YOCTO, type AssetDraft } from "./create-review";

const asset = (i: number, over: Partial<AssetDraft> = {}): AssetDraft => ({
  chainId: "46630", tokenAddress: `0x${String(i).repeat(40)}`, representation: `c${i}.rep.testnet`, custodyDomain: "custody-v1", referenceChainId: "", referenceAddress: "", ...over,
});
const NOW = 1_800_000_000_000;
const START = String(NOW + 15 * 60_000);
const ok = (assets: AssetDraft[], mode = "PriceGain", start: string | null = START) => buildCreateReview("arena.testnet", assets, mode, start, NOW);

describe("create_lifecycle_battle review", () => {
  it("builds the exact wire arguments the agent preview builds, for two and three communities", () => {
    for (const n of [2, 3]) {
      const r = ok(Array.from({ length: n }, (_, i) => asset(i + 1)));
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.method).toBe("create_lifecycle_battle");
      expect(r.receiver).toBe("arena.testnet");
      expect(Object.keys(r.args)).toEqual(["assets", "mode", "start_at_ms"]); // no bond, no duration, no usdc
      expect(r.args.start_at_ms).toBe(START);
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

  it("accepts an open arena with no community, and refuses too many, a missing mode and an unconfigured arena", () => {
    const open = ok([]);
    expect(open.ok && open.args).toEqual({ assets: [], mode: "PriceGain", start_at_ms: START });
    expect(open.ok && open.lines.find((l) => l.label === "Communities at creation")?.value).toMatch(/join before the start/);
    expect(ok(Array.from({ length: 17 }, (_, i) => asset(i % 9 + 1, { chainId: String(i + 1) }))).ok).toBe(false);
    expect((ok([asset(1), asset(2)], "") as { problems: string[] }).problems).toContain("choose a scoring mode");
    expect((buildCreateReview("", [], "PriceGain", START, NOW) as { problems: string[] }).problems).toContain("the arena contract id is not configured");
  });

  it("requires a start time between 1 minute and 7 days from now", () => {
    expect(ok([], "PriceGain", null)).toEqual({ ok: false, problems: ["choose a start time"] });
    expect(ok([], "PriceGain", String(NOW + 59_000))).toEqual({ ok: false, problems: ["the start time must be at least 1 minute from now"] });
    expect(ok([], "PriceGain", String(NOW + 60_000)).ok).toBe(true);
    expect(ok([], "PriceGain", String(NOW + 7 * 24 * 3_600_000)).ok).toBe(true);
    expect(ok([], "PriceGain", String(NOW + 7 * 24 * 3_600_000 + 1))).toEqual({ ok: false, problems: ["the start time must be at most 7 days from now"] });
    expect(ok([], "PriceGain", "12.5")).toEqual({ ok: false, problems: ["the start time is not a valid time"] });
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

import { previewMismatches, toActionRequest } from "./create-review";

describe("preview comparison before authorization", () => {
  const drafts = [asset(1), asset(2, { referenceChainId: "4663", referenceAddress: `0x${"bb".repeat(20)}` })];
  const review = (() => { const r = buildCreateReview("arena.testnet", drafts, "PriceGain", START, NOW); if (!r.ok) throw new Error("fixture"); return r; })();
  const preview = (over: Record<string, unknown> = {}) => ({
    accountId: "alice.testnet",
    transaction: { signerId: "alice.testnet", receiverId: "arena.testnet", actions: [{ methodName: "create_lifecycle_battle", args: review.args, deposit: CREATE_DEPOSIT_YOCTO }] },
    ...over,
  });

  it("builds the action request in the service's shape, with reference fields only when set", () => {
    const req = toActionRequest(drafts, "PriceGain", START) as { kind: string; mode: string; assets: Array<Record<string, unknown>> };
    expect(req).toMatchObject({ kind: "create_battle", mode: "PriceGain", startAtMs: START });
    expect(toActionRequest([], "PriceGain", null)).toEqual({ kind: "create_battle", assets: [], mode: "PriceGain" });
    expect(req.assets[0]).toEqual({ chainId: "46630", tokenAddress: `0x${"1".repeat(40)}`, representation: "c1.rep.testnet", custodyDomain: "custody-v1" });
    expect(req.assets[1]).toMatchObject({ referenceChainId: "4663", referenceAddress: `0x${"bb".repeat(20)}` });
  });

  it("accepts a preview that is exactly the reviewed call, regardless of key order", () => {
    expect(previewMismatches(preview(), review, "alice.testnet")).toEqual([]);
    const reversed = { start_at_ms: review.args.start_at_ms, mode: review.args.mode, assets:review.args.assets.map((a) => Object.fromEntries(Object.entries(a).reverse())) };
    const reordered = { ...preview(), transaction: { ...preview().transaction, actions: [{ methodName: "create_lifecycle_battle", args: reversed, deposit: CREATE_DEPOSIT_YOCTO }] } };
    expect(previewMismatches(reordered, review, "alice.testnet")).toEqual([]);
  });

  it("stops on any difference: account, contract, method, arguments, deposit or call count", () => {
    const base = preview();
    const tweak = (f: (p: ReturnType<typeof preview>) => void) => { const p = structuredClone(base); f(p); return previewMismatches(p, review, "alice.testnet"); };
    expect(tweak((p) => { p.transaction.signerId = "mallory.testnet"; })).toContain("the preview is for another account");
    expect(tweak((p) => { p.transaction.receiverId = "evil.testnet"; })).toContain("the preview targets another contract");
    expect(tweak((p) => { p.transaction.actions[0]!.methodName = "ft_transfer"; })).toContain("the preview calls another method");
    expect(tweak((p) => { (p.transaction.actions[0]!.args as { mode: string }).mode = "VolumeRatio"; })).toContain("the preview arguments differ from the reviewed arguments");
    expect(tweak((p) => { p.transaction.actions[0]!.deposit = "1"; })).toContain("the preview attaches another deposit");
    expect(tweak((p) => { p.transaction.actions.push({ methodName: "x", args: { assets: [], mode: "PriceGain" as const, start_at_ms: START }, deposit: "0" }); })).toContain("the preview does not contain exactly one call");
    expect(previewMismatches({}, review, "alice.testnet")).toEqual(["the preview has no transaction"]);
  });
});
