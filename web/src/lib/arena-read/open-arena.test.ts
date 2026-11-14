// FIXTURE-ONLY: synthetic battles and a fake RPC. Nothing here reads a chain.
import { describe, expect, it } from "vitest";
import {
  buildCancelReview,
  buildJoinReview,
  buildRefundReview,
  failedToStart,
  JOIN_DEPOSIT_YOCTO,
  localInputToMs,
  msToLocalInput,
  openPhase,
  readJoinableAssets,
  startTimeProblems, buildEscrowRefundReview, escrowRefundRequest, localTime } from "./open-arena";
import { battleStatus, type LifecycleCommunity, type LifecycleDetail } from "./lifecycle";

const NOW = 1_800_000_000_000;
const community = (vault: string, i = 1): LifecycleCommunity => ({
  chain_id: "46630", token_address: `0x${String(i).repeat(40)}`, representation: `c${i}.rep.testnet`, custody_domain: "d",
  reference_chain_id: null, reference_address: null, vault, audit_policy_hash: null, audit_evidence_hash: null, audit_expires_at_ms: null, backing_evidence_hash: null,
});
const detail = (over: Partial<LifecycleDetail["battle"]> = {}): LifecycleDetail => ({
  battleId: "4",
  battle: {
    creator: "alice.testnet", protocol: "dao.testnet", protocol_created: false, fee_bps: 10, creator_share_bps: 5000, mode: "PriceGain", locked: false,
    observation_policy_version: null, observation_policy_hash: null, principal_community: null, principal_amount: null, communities: [], ...over,
  },
  round: null, readiness: null, history: null,
});

describe("open arena phase", () => {
  const start = String(NOW + 60_000);
  it("counts down before the start", () => {
    expect(openPhase(detail({ start_at_ms: start }), NOW)).toEqual({ kind: "gathering", startAtMs: NOW + 60_000, msLeft: 60_000 });
  });
  it("is cancellable after the start below two funded communities, pending ones do not count", () => {
    const d = detail({ start_at_ms: start, communities: [community("5", 1), community("0", 2), community("0", 3)] });
    expect(openPhase(d, NOW + 60_000)).toMatchObject({ kind: "cancellable" });
  });
  it("waits for the lock after the start with two funded communities", () => {
    const d = detail({ start_at_ms: start, communities: [community("5", 1), community("1", 2)] });
    expect(openPhase(d, NOW + 60_000)).toMatchObject({ kind: "awaiting_lock" });
  });
  it("reports cancelled, locked and a battle without a start time, and never infers a start from the clock", () => {
    expect(openPhase(detail({ start_at_ms: start, cancelled: true }), NOW)).toEqual({ kind: "cancelled" });
    expect(openPhase(detail({ start_at_ms: start, locked: true }), NOW)).toEqual({ kind: "locked" });
    expect(openPhase(detail(), NOW)).toEqual({ kind: "no_start" });
    expect(openPhase(detail({ start_at_ms: null }), NOW)).toEqual({ kind: "no_start" });
    expect(openPhase(detail({ start_at_ms: start }), 0)).toMatchObject({ kind: "gathering" }); // server render: no clock yet
  });
  it("marks a cancelled battle's status", () => {
    expect(battleStatus(detail({ cancelled: true }))).toBe("cancelled");
    expect(battleStatus(detail())).toBe("open");
  });
});

describe("start time", () => {
  it("checks the arena's window", () => {
    expect(startTimeProblems(String(NOW + 60_000), NOW)).toEqual([]);
    expect(startTimeProblems(String(NOW + 1_000), NOW)).toHaveLength(1);
    expect(startTimeProblems(null, NOW)).toEqual(["choose a start time"]);
  });
  it("round-trips a local datetime input", () => {
    const ms = localInputToMs(msToLocalInput(NOW));
    expect(Math.abs(Number(ms) - NOW)).toBeLessThan(60_000);
    expect(localInputToMs("")).toBeNull();
    expect(localInputToMs("tomorrow")).toBeNull();
  });
});

describe("join, cancel and refund reviews mirror the agent preview", () => {
  it("join: exact args, storage budget and no token movement", () => {
    const r = buildJoinReview("arena.testnet", 4, "backing-cashcat.o.testnet", "CASHCAT");
    expect(r.ok && { method: r.method, args: r.args, deposit: r.depositYocto, receiver: r.receiver }).toEqual({
      method: "join_lifecycle_battle", args: { battle_id: 4, representation: "backing-cashcat.o.testnet" }, deposit: JOIN_DEPOSIT_YOCTO, receiver: "arena.testnet",
    });
    expect(r.ok && r.notes.join(" ")).toMatch(/moves no tokens/);
    expect(buildJoinReview("arena.testnet", 4, "")).toEqual({ ok: false, problems: ["choose a token to join with"] });
  });
  it("cancel: no deposit; refund: one yocto and a community index", () => {
    const c = buildCancelReview("arena.testnet", 4);
    expect(c.ok && [c.method, c.args, c.depositYocto]).toEqual(["cancel_lifecycle_battle", { battle_id: 4 }, "0"]);
    const r = buildRefundReview("arena.testnet", 4, 1);
    expect(r.ok && [r.method, r.args, r.depositYocto]).toEqual(["claim_lifecycle_refund", { battle_id: 4, community: 1 }, "1"]);
    expect(buildRefundReview("arena.testnet", 4, 16).ok).toBe(false);
    expect(buildCancelReview("", 0)).toEqual({ ok: false, problems: ["battle id must be a positive integer", "the arena contract id is not configured"] });
  });
});

describe("joinable allowlist read", () => {
  const entry = (i: number) => ({ chain_id: "46630", token_address: `0x${String(i % 10).repeat(40)}`, representation: `r${i}.testnet`, custody_domain: "d", reference_chain_id: null, reference_address: null });
  const rpc = (pages: unknown[][]) => {
    const calls: unknown[] = [];
    const doFetch = async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { params: { method_name: string; args_base64: string } };
      const args = JSON.parse(atob(body.params.args_base64)) as { from_index: string; limit: string };
      calls.push({ method: body.params.method_name, ...args });
      const page = pages.shift() ?? [];
      return Response.json({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify(page))) } });
    };
    return { calls, doFetch };
  };
  it("reads every page with string u64 arguments", async () => {
    const { calls, doFetch } = rpc([Array.from({ length: 50 }, (_, i) => entry(i)), [entry(50)]]);
    const items = await readJoinableAssets("https://rpc", "arena.testnet", doFetch);
    expect(items).toHaveLength(51);
    expect(calls).toEqual([
      { method: "get_lifecycle_joinable_assets", from_index: "0", limit: "50" },
      { method: "get_lifecycle_joinable_assets", from_index: "50", limit: "50" },
    ]);
  });
  it("refuses a malformed entry", async () => {
    const { doFetch } = rpc([[{ representation: 5 }]]);
    await expect(readJoinableAssets("https://rpc", "arena.testnet", doFetch)).rejects.toThrow(/malformed/);
  });
});

describe("escrow refund review (D41)", () => {
  it("is one claim_lifecycle_escrow_refund with one yocto, in the shape the agent previews", () => {
    const r = buildEscrowRefundReview("arena.testnet", 17, "CASHCAT");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ receiver: "arena.testnet", method: "claim_lifecycle_escrow_refund", args: { battle_id: 17 }, depositYocto: "1" });
    expect(escrowRefundRequest(17)).toEqual({ kind: "claim_escrow_refund", battleId: 17 });
  });
  it("refuses a bad battle id and an unconfigured arena", () => {
    expect(buildEscrowRefundReview("arena.testnet", 0).ok).toBe(false);
    expect(buildEscrowRefundReview("", 17).ok).toBe(false);
  });
});

describe("failedToStart", () => {
  const base = { status: "open", startAtMs: "1000", enteredCount: 1 };
  it("is true once the start passed with fewer than two funded communities and the battle is still open", () => {
    expect(failedToStart(base, 1000)).toBe(true);
    expect(failedToStart({ ...base, enteredCount: 0 }, 5000)).toBe(true);
  });
  it("is false before the start, with two funded communities, or once the arena settled the state", () => {
    expect(failedToStart(base, 999)).toBe(false);
    expect(failedToStart({ ...base, enteredCount: 2 }, 5000)).toBe(false);
    for (const status of ["locked", "decided", "cancelled"]) expect(failedToStart({ ...base, status }, 5000)).toBe(false);
  });
  it("is false without a usable start time", () => {
    expect(failedToStart({ ...base, startAtMs: null }, 5000)).toBe(false);
    expect(failedToStart({ ...base, startAtMs: "soon" }, 5000)).toBe(false);
  });
});

describe("localTime", () => {
  const ms = Date.UTC(2026, 10, 14, 3, 20);
  it("shows day, month, year and a 12-hour clock with AM or PM in the given time zone", () => {
    expect(localTime(ms, "Asia/Jakarta")).toBe("14 Nov 2026, 10:20 AM");
    expect(localTime(ms, "America/New_York")).toBe("13 Nov 2026, 10:20 PM");
    expect(localTime(Date.UTC(2026, 10, 14, 12, 5), "Asia/Jakarta")).toBe("14 Nov 2026, 7:05 PM");
  });
});
