import { describe, expect, it } from "vitest";
import {
  buildCreatorDepositReview,
  buildPrepayReview,
  createMessage,
  creatorDepositRequest,
  parseCreateModes,
  prepayRequest,
  previewMismatches,
  PREPAY_STORAGE_YOCTO,
  type CreatorDeposit,
} from "./create-review";

const NOW = 1_800_000_000_000;
const START = String(NOW + 15 * 60_000);
const deposit = (over: Partial<CreatorDeposit> = {}): CreatorDeposit => ({ representation: "pepe.rep.testnet", amount: "100", label: "PEPE", ...over });
const ok = (d: CreatorDeposit = deposit(), mode = "PriceGain", start: string | null = START) => buildCreatorDepositReview("arena.testnet", d, mode, start, NOW);

describe("creator deposit review (D41)", () => {
  it("is one ft_transfer_call of the creator's token with the lifecycle_create message", () => {
    const r = ok();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receiver).toBe("pepe.rep.testnet");
    expect(r.method).toBe("ft_transfer_call");
    expect(r.depositYocto).toBe("1");
    expect(r.args).toEqual({
      receiver_id: "arena.testnet",
      amount: "100",
      msg: JSON.stringify({ action: "lifecycle_create", mode: "PriceGain", start_at_ms: START }),
    });
    expect(createMessage("PriceGain", START)).toBe((r.args as { msg: string }).msg);
    // No bond, no duration, no asset list: the battle is created by the deposit.
    expect(Object.keys(r.args as object)).toEqual(["receiver_id", "amount", "msg"]);
  });

  it("says the deposit is held in escrow, returned when refused, and that storage is not a bond", () => {
    const r = ok();
    const notes = r.ok ? r.notes.join(" ") : "";
    expect(notes).toMatch(/held in escrow/);
    expect(notes).toMatch(/tokens are returned/);
    expect(notes).toMatch(/not a bond/);
  });

  it("refuses a missing token, a bad amount, an unconfigured arena and a missing mode", () => {
    expect((ok(deposit({ representation: "" })) as { problems: string[] }).problems).toContain("choose the token you deposit first");
    expect((ok(deposit({ representation: "Bad Account" })) as { problems: string[] }).problems).toContain("choose the token you deposit first");
    for (const amount of ["", "0", "-1", "1.5", "abc"]) {
      expect((ok(deposit({ amount })) as { problems: string[] }).problems).toContain("enter the amount you deposit");
    }
    expect((buildCreatorDepositReview("", deposit(), "PriceGain", START, NOW) as { problems: string[] }).problems).toContain("the arena contract id is not configured");
    expect((ok(deposit(), "") as { problems: string[] }).problems).toContain("choose a challenge");
  });

  it("offers only the modes the arena's observation policy can run", () => {
    expect(parseCreateModes(undefined)).toEqual(["PriceGain"]);
    expect(parseCreateModes(" VolumeRatio , PriceGain,TWAP,PriceGain")).toEqual(["VolumeRatio", "PriceGain"]);
    expect(parseCreateModes("TWAP")).toEqual(["PriceGain"]);
    const refused = buildCreatorDepositReview("arena.testnet", deposit(), "VolumeRatio", START, NOW, ["PriceGain"]);
    expect(!refused.ok && refused.problems[0]).toMatch(/not live on this arena yet/);
    expect(buildCreatorDepositReview("arena.testnet", deposit(), "PriceGain", START, NOW, ["PriceGain"]).ok).toBe(true);
  });

  it("requires a start time between 1 minute and 7 days from now", () => {
    const only = (start: string | null) => ok(deposit(), "PriceGain", start);
    expect(only(null)).toEqual({ ok: false, problems: ["choose a start time"] });
    expect(only(String(NOW + 59_000))).toEqual({ ok: false, problems: ["the start time must be at least 1 minute from now"] });
    expect(only(String(NOW + 60_000)).ok).toBe(true);
    expect(only(String(NOW + 7 * 24 * 3_600_000)).ok).toBe(true);
    expect(only(String(NOW + 7 * 24 * 3_600_000 + 1))).toEqual({ ok: false, problems: ["the start time must be at most 7 days from now"] });
    expect(only("12.5")).toEqual({ ok: false, problems: ["the start time is not a valid time"] });
  });

  it("builds the action request in the service's shape and never carries the label", () => {
    expect(creatorDepositRequest(deposit(), "PriceGain", START)).toEqual({
      kind: "create_battle", representation: "pepe.rep.testnet", amount: "100", mode: "PriceGain", startAtMs: START,
    });
    expect(creatorDepositRequest(deposit({ label: "OTHER" }), "PriceGain", START)).toEqual(creatorDepositRequest(deposit(), "PriceGain", START));
    expect(creatorDepositRequest(deposit(), "PriceGain", null)).not.toHaveProperty("startAtMs");
  });
});

describe("storage prepayment review", () => {
  it("is one payable lifecycle_storage_deposit on the arena, described as not a bond", () => {
    const r = buildPrepayReview("arena.testnet");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ receiver: "arena.testnet", method: "lifecycle_storage_deposit", args: {}, depositYocto: PREPAY_STORAGE_YOCTO });
    expect(r.notes.join(" ")).toMatch(/not a bond/);
    expect(prepayRequest()).toEqual({ kind: "prepay_storage", amountYocto: PREPAY_STORAGE_YOCTO });
  });
  it("refuses an unconfigured arena and a zero amount", () => {
    expect(buildPrepayReview("").ok).toBe(false);
    expect(buildPrepayReview("arena.testnet", "0").ok).toBe(false);
  });
});

describe("preview comparison before authorization", () => {
  const review = (() => { const r = ok(); if (!r.ok) throw new Error("fixture"); return r; })();
  const preview = () => ({
    accountId: "alice.testnet",
    transaction: { signerId: "alice.testnet", receiverId: "pepe.rep.testnet", actions: [{ methodName: "ft_transfer_call", args: review.args, deposit: "1" }] },
  });

  it("accepts a preview that is exactly the reviewed call, regardless of key order", () => {
    expect(previewMismatches(preview(), review, "alice.testnet")).toEqual([]);
    const args = review.args as Record<string, unknown>;
    const reordered = { ...preview(), transaction: { ...preview().transaction, actions: [{ methodName: "ft_transfer_call", args: Object.fromEntries(Object.entries(args).reverse()), deposit: "1" }] } };
    expect(previewMismatches(reordered, review, "alice.testnet")).toEqual([]);
  });

  it("stops on any difference: account, contract, method, arguments, deposit or call count", () => {
    const tweak = (f: (p: ReturnType<typeof preview>) => void) => { const p = structuredClone(preview()); f(p); return previewMismatches(p, review, "alice.testnet"); };
    expect(tweak((p) => { p.transaction.signerId = "mallory.testnet"; })).toContain("the preview is for another account");
    expect(tweak((p) => { p.transaction.receiverId = "evil.testnet"; })).toContain("the preview targets another contract");
    expect(tweak((p) => { p.transaction.actions[0]!.methodName = "ft_transfer"; })).toContain("the preview calls another method");
    expect(tweak((p) => { (p.transaction.actions[0]!.args as { amount: string }).amount = "101"; })).toContain("the preview arguments differ from the reviewed arguments");
    expect(tweak((p) => { (p.transaction.actions[0]!.args as { msg: string }).msg = createMessage("VolumeRatio", START); })).toContain("the preview arguments differ from the reviewed arguments");
    expect(tweak((p) => { p.transaction.actions[0]!.deposit = "0"; })).toContain("the preview attaches another deposit");
    expect(tweak((p) => { p.transaction.actions.push({ methodName: "x", args: {}, deposit: "0" }); })).toContain("the preview does not contain exactly one call");
    expect(previewMismatches({}, review, "alice.testnet")).toEqual(["the preview has no transaction"]);
  });
});
