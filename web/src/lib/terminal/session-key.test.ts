import { describe, expect, it } from "vitest";
import {
  assertScopedMethods,
  canKeyDeposit,
  canSessionSign,
  createSessionPolicy,
  createSessionStore,
  estimateGasCostYocto,
  FORBIDDEN_SESSION_METHODS,
  isKeyRejection,
  recordSessionUse,
  remainingAllowanceYocto,
  SESSION_METHODS,
  type SignableTx,
  type StoredSession,
} from "./session-key";

const T = 1_000;
const policy = createSessionPolicy({ accountId: "a.testnet", arenaId: "arena.testnet", nowMs: T, ttlMs: 60_000, gasAllowanceNear: "0.25" });
const deposit: SignableTx = { receiverId: "arena.testnet", method: "deposit_from_balance", deposit: "0", gas: "200 Tgas" };

describe("session key scope", () => {
  it("allows exactly deposit_from_balance, claim and withdraw_initial_deposit", () => {
    expect([...SESSION_METHODS].sort()).toEqual(["claim", "deposit_from_balance", "withdraw_initial_deposit"]);
    expect(policy.methods).toEqual([...SESSION_METHODS]);
  });

  it("never contains withdraw_liquid or anything that moves funds out", () => {
    for (const m of FORBIDDEN_SESSION_METHODS) expect((SESSION_METHODS as readonly string[]).includes(m)).toBe(false);
    expect((SESSION_METHODS as readonly string[]).includes("withdraw_liquid")).toBe(false);
    expect(() => assertScopedMethods(["claim", "withdraw_liquid"])).toThrow("withdraw_liquid");
    expect(() => assertScopedMethods(["ft_transfer_call"])).toThrow();
    expect(() => assertScopedMethods(["something_else"])).toThrow("not an allowed");
    expect(() => assertScopedMethods([])).toThrow();
    expect(() => assertScopedMethods(SESSION_METHODS)).not.toThrow();
  });

  it("signs scoped arena calls without a deposit and rejects everything else", () => {
    expect(canSessionSign(policy, deposit, T + 1)).toEqual({ ok: true });
    expect(canSessionSign(policy, { ...deposit, method: "claim" }, T + 1).ok).toBe(true);
    expect(canSessionSign(policy, { ...deposit, method: "withdraw_liquid" }, T + 1).ok).toBe(false);
    expect(canSessionSign(policy, { ...deposit, method: "deposit_with_credit" }, T + 1).ok).toBe(false);
    expect(canSessionSign(policy, { ...deposit, receiverId: "usdc.testnet", method: "ft_transfer_call", deposit: "1" }, T + 1).ok).toBe(false);
    expect(canSessionSign(policy, { ...deposit, receiverId: "evil.testnet" }, T + 1).ok).toBe(false);
    expect(canSessionSign(policy, { ...deposit, deposit: "1" }, T + 1)).toMatchObject({ ok: false });
  });
});

describe("session key expiry and allowance fallback", () => {
  it("falls back at expiry and without a key", () => {
    expect(canSessionSign(policy, deposit, T + 60_000)).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
    expect(canSessionSign(policy, deposit, T + 59_999).ok).toBe(true);
    expect(canSessionSign(null, deposit, T).ok).toBe(false);
  });

  it("charges the allowance per call and falls back when it runs out", () => {
    const cost = estimateGasCostYocto("200 Tgas");
    expect(cost).toBe(2n * 10n ** 22n);
    let p = createSessionPolicy({ accountId: "a.testnet", arenaId: "arena.testnet", nowMs: T, ttlMs: 60_000, gasAllowanceNear: "0.07" });
    expect(canSessionSign(p, deposit, T).ok).toBe(true);
    p = recordSessionUse(p, deposit);
    p = recordSessionUse(p, deposit);
    expect(remainingAllowanceYocto(p)).toBe(7n * 10n ** 22n - 2n * cost);
    expect(canSessionSign(p, deposit, T)).toMatchObject({ ok: true });
    p = recordSessionUse(p, deposit);
    expect(canSessionSign(p, deposit, T)).toMatchObject({ ok: false, reason: expect.stringContaining("allowance") });
    expect(remainingAllowanceYocto(p)).toBe(10n ** 22n);
    expect(remainingAllowanceYocto({ ...p, gasUsedYocto: p.gasAllowanceYocto + 1n })).toBe(0n);
  });

  it("canKeyDeposit reflects expiry, allowance and scope", () => {
    const session: StoredSession = { policy, secretKey: "ed25519:x", publicKey: "ed25519:y" };
    expect(canKeyDeposit(session, "arena.testnet", T)).toBe(true);
    expect(canKeyDeposit(session, "arena.testnet", T + 60_000)).toBe(false);
    expect(canKeyDeposit(session, "other.testnet", T)).toBe(false);
    expect(canKeyDeposit({ ...session, policy: { ...policy, gasUsedYocto: policy.gasAllowanceYocto } }, "arena.testnet", T)).toBe(false);
    expect(canKeyDeposit(null, "arena.testnet", T)).toBe(false);
  });

  it("recognizes key rejections but not ordinary failures", () => {
    expect(isKeyRejection(new Error("Access Key ... does not have enough allowance"))).toBe(true);
    expect(isKeyRejection(new Error("AccessKeyNotFound"))).toBe(true);
    expect(isKeyRejection(new Error("MethodNameMismatch"))).toBe(true);
    expect(isKeyRejection(new Error("Deposit refused"))).toBe(false);
    expect(isKeyRejection("network down")).toBe(false);
  });

  it("rejects an invalid gas allowance", () => {
    expect(() => createSessionPolicy({ accountId: "a", arenaId: "b", nowMs: 0, ttlMs: 1, gasAllowanceNear: "x" })).toThrow();
  });
});

describe("session storage", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };

  it("round-trips a session per account and clears it", () => {
    const backing = mem();
    const store = createSessionStore(backing);
    store.save({ policy: recordSessionUse(policy, deposit), secretKey: "ed25519:xyz", publicKey: "ed25519:pub" });
    const loaded = store.load("a.testnet")!;
    expect(loaded.policy.gasAllowanceYocto).toBe(policy.gasAllowanceYocto);
    expect(loaded.policy.gasUsedYocto).toBe(estimateGasCostYocto("200 Tgas"));
    expect(loaded.publicKey).toBe("ed25519:pub");
    expect(store.load("b.testnet")).toBeNull();
    store.clear();
    expect(store.load("a.testnet")).toBeNull();
  });

  it("keeps an expired session loadable so it can still be revoked, but it cannot sign", () => {
    const store = createSessionStore(mem());
    store.save({ policy, secretKey: "ed25519:xyz", publicKey: "ed25519:pub" });
    const loaded = store.load("a.testnet")!;
    expect(canSessionSign(loaded.policy, deposit, T + 120_000).ok).toBe(false);
  });
});
