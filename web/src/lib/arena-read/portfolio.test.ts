// FIXTURE-ONLY: synthetic data; not observed on any network.
import { describe, expect, it } from "vitest";
import {
  LatestRead, RequestIdStore, buildPayoutReview, describePayouts, emptyPayoutsText, entitlementAvailability, envelopeLabel,
  historyNote, isValidRequestId, newRequestId, normalizePositions, payoutGate, payoutRequest, reconcileGate, validatePayoutDraft,
  type KeyValueStore, type PayoutItem,
} from "./portfolio";
import { previewMismatches } from "./create-review";

const DEST = "0x" + "ab".repeat(20);
const draft = { backing: "pepe.rep.testnet", amount: "100", destination: DEST };
const caps = { deploymentId: "d", companions: { payout: "payout.testnet" }, capabilities: { custody: { enabled: true, reasons: ["ok"] } } };
const custody = { sourceTransfersEnabled: true, reasons: [] };
const ent = [{ backing: "pepe.rep.testnet", available: "150" }];
const item = (displayState: string, over: Partial<PayoutItem> = {}): PayoutItem => ({
  state: "x", displayState, displayLabel: `label ${displayState}`, terminal: displayState === "confirmed" || displayState === "restored", chainId: "46630", amount: "100", backing: "pepe.rep.testnet", ...over,
});
const mem = (): KeyValueStore & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

describe("positions", () => {
  it("groups by original asset, keeps exact u64+ strings and never adds different assets", () => {
    const groups = normalizePositions({ accountId: "a", positions: [
      { battleId: 2, community: 1, representation: "b.rep", amount: "18446744073709551615" },
      { battleId: 1, community: 0, representation: "a.rep", amount: "5" },
      { battleId: 3, community: 0, representation: "b.rep", amount: "1" },
    ] });
    expect(groups.map((g) => g.asset)).toEqual(["a.rep", "b.rep"]);
    expect(groups[1]!.subtotal).toBe("18446744073709551616");
    expect(groups[0]!.subtotal).toBe("5");
  });
  it("flags a malformed amount and withholds the subtotal", () => {
    const [g] = normalizePositions({ accountId: "a", positions: [{ battleId: 1, community: 0, representation: "a.rep", amount: "1.5" }] });
    expect(g!.rows[0]!.valid).toBe(false);
    expect(g!.subtotal).toBeNull();
  });
});

describe("entitlements and history honesty", () => {
  it("an empty unavailable entitlement list is never zero", () => {
    const a = entitlementAvailability({ available: false }, ["no deployed contract exposes per-account entitlements yet; an empty list is not a zero entitlement"]);
    expect(a).toEqual({ available: false, reason: expect.stringContaining("no deployed contract exposes") });
  });
  it("only an explicit available:true is available", () => {
    expect(entitlementAvailability({ available: true }, []).available).toBe(true);
    expect(entitlementAvailability(null, []).available).toBe(false);
  });
  it("bounded or terminal-omitting history never claims no payouts", () => {
    const n = historyNote(["confirmed and restored payouts are not listed by the payout contract", "only the first 200 payout index positions were scanned"]);
    expect(n.complete).toBe(false);
    expect(emptyPayoutsText(n)).toContain("not proof");
    expect(emptyPayoutsText({ complete: true, notes: [] })).toContain("complete history");
  });
});

describe("payout states", () => {
  it("only confirmed is paid; reserved, broadcast and pending are not", () => {
    const rows = describePayouts(["reserved", "broadcast", "confirmation_pending", "confirmed", "reverted", "restored"].map((s) => item(s)));
    expect(rows.map((r) => r.paid)).toEqual([false, false, false, true, false, false]);
    expect(rows.map((r) => r.stage)).toEqual(["reserved", "in_flight", "in_flight", "paid", "reverted", "restored"]);
    expect(rows[1]!.detail).toContain("Not paid");
  });
  it("an unknown stage is treated as unresolved, not paid", () => {
    const [r] = describePayouts([item("mystery", { terminal: true })]);
    expect(r!.paid).toBe(false);
    expect(r!.unresolved).toBe(true);
  });
});

describe("payout request review", () => {
  const id = "11".repeat(32);
  it("validates exact integer amount and a 20-byte non-zero destination", () => {
    expect(validatePayoutDraft(draft)).toEqual([]);
    expect(validatePayoutDraft({ ...draft, amount: "1.5" })).toHaveLength(1);
    expect(validatePayoutDraft({ ...draft, amount: "0" })).toHaveLength(1);
    expect(validatePayoutDraft({ ...draft, destination: "0x1234" })).toHaveLength(1);
    expect(validatePayoutDraft({ ...draft, destination: "0x" + "0".repeat(40) })).toHaveLength(1);
  });
  it("builds the exact request_payout call and matches an equal canonical preview", () => {
    const r = buildPayoutReview("payout.testnet", draft, id);
    if (!r.ok) throw new Error("expected ok");
    expect(r.method).toBe("request_payout");
    const args = r.args as { request_id: number[]; destination: number[] };
    expect(args.request_id).toHaveLength(32);
    expect(args.destination).toHaveLength(20);
    const preview = { accountId: "alice.testnet", transaction: { signerId: "alice.testnet", receiverId: "payout.testnet", actions: [{ methodName: "request_payout", args: r.args, deposit: r.depositYocto }] } };
    expect(previewMismatches(preview, r, "alice.testnet")).toEqual([]);
    const other = { ...preview, transaction: { ...preview.transaction, actions: [{ methodName: "request_payout", args: { ...(r.args as object), amount: "101" }, deposit: r.depositYocto }] } };
    expect(previewMismatches(other, r, "alice.testnet")).toContain("the preview arguments differ from the reviewed arguments");
  });
  it("is blocked without a payout contract or with a zero request id", () => {
    expect(buildPayoutReview(null, draft, id).ok).toBe(false);
    expect(buildPayoutReview("payout.testnet", draft, "0".repeat(64)).ok).toBe(false);
  });
  it("the action request carries the fixed id and a lowercase destination", () => {
    expect(payoutRequest({ ...draft, destination: "0x" + "AB".repeat(20) }, id)).toEqual({ kind: "payout", backing: draft.backing, amount: "100", destination: DEST, requestId: id });
  });
});

describe("stable request id", () => {
  it("generates 32 non-zero bytes and rejects an all-zero draw", () => {
    let calls = 0;
    const id = newRequestId(() => (calls++ === 0 ? new Uint8Array(32) : new Uint8Array(32).fill(9)));
    expect(isValidRequestId(id)).toBe(true);
    expect(calls).toBe(2);
  });
  it("is reused across reload for the same request and differs when any field changes", () => {
    const store = mem();
    const a = new RequestIdStore(store).obtain("alice", "dep", draft);
    expect(a.reused).toBe(false);
    const afterReload = new RequestIdStore(store).obtain("alice", "dep", draft);
    expect(afterReload).toMatchObject({ requestId: a.requestId, reused: true });
    for (const changed of [{ ...draft, amount: "101" }, { ...draft, backing: "x.rep" }, { ...draft, destination: "0x" + "cd".repeat(20) }]) {
      expect(new RequestIdStore(store).obtain("alice", "dep", changed).requestId).not.toBe(a.requestId);
    }
    expect(new RequestIdStore(store).obtain("bob", "dep", draft).requestId).not.toBe(a.requestId);
    expect(new RequestIdStore(store).obtain("alice", "other", draft).requestId).not.toBe(a.requestId);
  });
  it("stores only the request id, never a token or amount-bearing payload", () => {
    const store = mem();
    const { requestId } = new RequestIdStore(store).obtain("alice", "dep", draft);
    expect([...store.m.values()]).toEqual([requestId]);
  });
  it("keeps the id in memory when storage throws and reports it is not persisted", () => {
    const broken: KeyValueStore = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); }, removeItem: () => { throw new Error("no"); } };
    const s = new RequestIdStore(broken);
    const a = s.obtain("alice", "dep", draft);
    expect(a.persisted).toBe(false);
    expect(s.obtain("alice", "dep", draft)).toMatchObject({ requestId: a.requestId, reused: true });
  });
  it("release makes the next request a new one", () => {
    const store = mem();
    const s = new RequestIdStore(store);
    const a = s.obtain("alice", "dep", draft);
    s.release("alice", "dep", draft);
    expect(s.obtain("alice", "dep", draft).requestId).not.toBe(a.requestId);
  });
});

describe("payout gate", () => {
  const base = { connected: true, capabilities: caps, custody, entitlements: ent, draft };
  it("is enabled only when every requirement holds", () => {
    expect(payoutGate(base)).toEqual({ enabled: true, reasons: [] });
  });
  it("names each unmet requirement", () => {
    expect(payoutGate({ ...base, connected: false }).reasons).toContain("connect a wallet");
    expect(payoutGate({ ...base, capabilities: { ...caps, capabilities: {} } }).reasons[0]).toContain("custody capability is not declared");
    expect(payoutGate({ ...base, capabilities: { ...caps, capabilities: { custody: { enabled: false, reasons: ["no custody path configured"] } } } }).reasons[0]).toContain("no custody path configured");
    expect(payoutGate({ ...base, capabilities: { ...caps, companions: { payout: null } } }).reasons[0]).toContain("no payout contract");
    expect(payoutGate({ ...base, custody: { sourceTransfersEnabled: false, reasons: ["deposit custody has no withdraw"] } }).reasons[0]).toContain("#148");
    expect(payoutGate({ ...base, custody: null }).enabled).toBe(false);
    expect(payoutGate({ ...base, capabilities: null }).enabled).toBe(false);
  });
  it("needs a positive entitlement that covers the amount; unknown or zero is not positive", () => {
    expect(payoutGate({ ...base, entitlements: null }).enabled).toBe(false);
    expect(payoutGate({ ...base, entitlements: [] }).enabled).toBe(false);
    expect(payoutGate({ ...base, entitlements: [{ backing: "pepe.rep.testnet", available: "0" }] }).enabled).toBe(false);
    expect(payoutGate({ ...base, entitlements: [{ backing: "other.rep", available: "999" }] }).enabled).toBe(false);
    expect(payoutGate({ ...base, draft: { ...draft, amount: "151" } }).reasons[0]).toContain("exceeds");
  });
});

describe("reconcile before retry", () => {
  it("blocks when status is unread or a same-asset same-amount payout is unresolved", () => {
    expect(reconcileGate(null, draft)).toHaveLength(1);
    expect(reconcileGate(describePayouts([item("broadcast")]), draft)).toHaveLength(1);
    expect(reconcileGate(describePayouts([item("confirmed")]), draft)).toEqual([]);
    expect(reconcileGate(describePayouts([item("broadcast", { amount: "7" })]), draft)).toEqual([]);
  });
});

describe("stale response guard", () => {
  it("a newer read aborts and invalidates the older one", () => {
    const g = new LatestRead();
    const a = g.begin("alice");
    const b = g.begin("bob");
    expect(a.signal.aborted).toBe(true);
    expect(a.isCurrent()).toBe(false);
    expect(b.isCurrent()).toBe(true);
  });
  it("A -> B -> A: the first A response stays rejected", () => {
    const g = new LatestRead();
    const first = g.begin("alice");
    g.begin("bob");
    const again = g.begin("alice");
    expect(first.isCurrent()).toBe(false);
    expect(again.isCurrent()).toBe(true);
  });
  it("cancel (sign-out) rejects everything in flight", () => {
    const g = new LatestRead();
    const a = g.begin("alice");
    g.cancel();
    expect(a.isCurrent()).toBe(false);
  });
});

describe("envelope label", () => {
  it("labels fixtures and freshness", () => {
    expect(envelopeLabel({ source: { kind: "fixture", name: "fixture-state" }, observedAt: "2026-01-01T00:00:00.000Z", freshness: "unknown" }, Date.parse("2026-01-01T00:00:10.000Z"))).toContain("FIXTURE (not live)");
    expect(envelopeLabel({ source: { kind: "live", name: "arena" }, observedAt: null, freshness: "stale" }, 0)).toContain("stale");
  });
});
