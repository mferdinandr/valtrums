// FIXTURE-ONLY: synthetic dispositions. Nothing here reads a chain.
import { describe, expect, it } from "vitest";
import {
  buildExecuteReview,
  buildReserveEscrowReview,
  buildBurnReview,
  canRequestBurn,
  buildVoteReview,
  burnSharePercent,
  daoStep,
  ENTITLEMENT_DEPOSIT_YOCTO,
  voteMsLeft,
  type Disposition,
} from "./dao";

const base: Disposition = {
  status: "voting",
  window_secs: "30",
  opens_at_ns: "1000000000000",
  closes_at_ns: "1030000000000",
  burn_weight: "0",
  return_weight: "0",
  escrow_reserved: false,
  burn_total: "0",
  return_total: "0",
  released: 0,
  total_releases: 0,
};
const decided: Disposition = { ...base, status: "decided", burn_weight: "30", return_weight: "70", burn_total: "30", return_total: "70", total_releases: 4 };

describe("vote window", () => {
  it("counts down to the close and never goes negative", () => {
    expect(voteMsLeft(base, 1_000_000 + 10_000)).toBe(20_000);
    expect(voteMsLeft(base, 1_040_000)).toBe(0);
  });
  it("is zero when the clock is unread or the vote is not open", () => {
    expect(voteMsLeft(base, 0)).toBe(0);
    expect(voteMsLeft(decided, 1_000_000)).toBe(0);
  });
});

describe("burn share", () => {
  it("is null until a vote is cast and rounds down", () => {
    expect(burnSharePercent(base)).toBeNull();
    expect(burnSharePercent({ ...base, burn_weight: "1", return_weight: "2" })).toBe(33);
    expect(burnSharePercent(decided)).toBe(30);
  });
});

describe("next step", () => {
  it("explains the states that have no step", () => {
    expect(daoStep(null).kind).toBe("none");
    expect(daoStep({ ...base, status: "no_winner" }).kind).toBe("none");
    expect(daoStep({ ...base, status: "no_vote" }).kind).toBe("none");
  });
  it("follows the vote, the escrow and the batches", () => {
    expect(daoStep(base).kind).toBe("voting");
    expect(daoStep({ ...base, status: "undecided_escrowed" }).kind).toBe("undecided");
    expect(daoStep(decided).kind).toBe("reserve_escrow");
    expect(daoStep({ ...decided, escrow_reserved: true, released: 1 })).toEqual({ kind: "execute", batch: 3, remaining: 3 });
    expect(daoStep({ ...decided, escrow_reserved: true, total_releases: 25 })).toEqual({ kind: "execute", batch: 10, remaining: 25 });
    expect(daoStep({ ...decided, escrow_reserved: true, released: 4 }).kind).toBe("done");
  });
});

describe("reviews match the action service's calls", () => {
  it("vote carries the string battle id, the burn flag and the storage deposit", () => {
    const r = buildVoteReview("arena.testnet", 31, 100);
    expect(r).toMatchObject({ ok: true, method: "vote_lifecycle_disposition", args: { battle_id: "31", burn_percent: 100 }, depositYocto: "10000000000000000000000", gasTgas: "30" });
    expect(buildVoteReview("arena.testnet", 31, 25)).toMatchObject({ args: { battle_id: "31", burn_percent: 25 } });
  });
  it("reserve escrow uses its own deposit and gas", () => {
    expect(buildReserveEscrowReview("arena.testnet", 31)).toMatchObject({ ok: true, method: "reserve_lifecycle_escrow", args: { battle_id: "31" }, depositYocto: "10000000000000000000000", gasTgas: "80" });
  });
  it("execute attaches one entitlement deposit per release in the batch", () => {
    const r = buildExecuteReview("arena.testnet", 31, 3, 3);
    expect(r).toMatchObject({ ok: true, method: "execute_lifecycle_disposition", args: { battle_id: "31", max_releases: 3 }, gasTgas: "250" });
    if (r.ok) expect(r.depositYocto).toBe((ENTITLEMENT_DEPOSIT_YOCTO * 3n).toString());
  });
  it("rejects a bad battle id, a missing arena and an out-of-range batch", () => {
    expect(buildVoteReview("arena.testnet", 0, 100).ok).toBe(false);
    expect(buildVoteReview("arena.testnet", 31, 101).ok).toBe(false);
    expect(buildVoteReview("arena.testnet", 31, 12.5).ok).toBe(false);
    expect(buildReserveEscrowReview("", 31).ok).toBe(false);
    expect(buildExecuteReview("arena.testnet", 31, 11, 11).ok).toBe(false);
  });
});

describe("burn to the sink", () => {
  const facts = { releaseId: "ab".repeat(32), amount: "33", recorded: true, sink: "0x000000000000000000000000000000000000dEaD", confirmed: "0", requestStatus: null };
  it("builds the request from the recorded release and the frozen sink", () => {
    const r = buildBurnReview("payout.testnet", "arena.testnet", "backing-cashcat.testnet", facts);
    expect(r).toMatchObject({ ok: true, receiver: "payout.testnet", method: "request_dao_burn", depositYocto: "30000000000000000000000", gasTgas: "150" });
    if (r.ok) {
      const args = r.args as { backing: string; holder: string; request_id: number[]; destination: number[] };
      expect(args.backing).toBe("backing-cashcat.testnet");
      expect(args.holder).toBe("arena.testnet");
      expect(args.request_id).toHaveLength(32);
      expect(args.request_id[0]).toBe(0xab);
      expect(args.destination).toHaveLength(20);
      expect(args.destination[19]).toBe(0xad);
    }
  });
  it("refuses an unrecorded release, an unset sink and a missing payout contract", () => {
    expect(buildBurnReview("payout.testnet", "arena.testnet", "b.testnet", { ...facts, recorded: false }).ok).toBe(false);
    expect(buildBurnReview("payout.testnet", "arena.testnet", "b.testnet", { ...facts, sink: null }).ok).toBe(false);
    expect(buildBurnReview(null, "arena.testnet", "b.testnet", facts).ok).toBe(false);
  });
  it("allows a burn request only before one exists, or after the earlier one was restored", () => {
    expect(canRequestBurn(facts)).toBe(true);
    expect(canRequestBurn({ ...facts, requestStatus: "signing_requested" })).toBe(false);
    expect(canRequestBurn({ ...facts, requestStatus: "broadcast" })).toBe(false);
    expect(canRequestBurn({ ...facts, requestStatus: "restored" })).toBe(true);
    expect(canRequestBurn({ ...facts, requestStatus: "confirmed", confirmed: "33" })).toBe(false);
  });
});
