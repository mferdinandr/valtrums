// FIXTURE-ONLY: fake transport and synthetic records; no network is contacted.
import { staticReferenceRegistry } from "../../src/reference-registry.js";
import { describe, expect, it } from "vitest";
import type { AuditRecord } from "../../src/audit/decision.js";
import { AuditSubmitter } from "../../src/audit/approval.js";
import { loadAuditConfig } from "../../src/audit/config.js";
import { LifecycleLocker, LOCK_DEPOSIT } from "../../src/audit/lifecycle-lock.js";
import { createLifecycleAuditPass, type LifecycleBattleView } from "../../src/audit/lifecycle-pass.js";
import { FIXTURE_RESOLVED, NOW, REF_CHAIN, REF_TOKEN, TOKEN, refGoplus, refLp, registry } from "./fixtures.js";

const rec = (result: "pass" | "pending", expiresAt: string | null): AuditRecord =>
  ({ result, expiresAt }) as unknown as AuditRecord;
const inMs = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

function locker(opts: { records: Map<string, AuditRecord>; failCalls?: number; neverLocks?: boolean }) {
  let clock = NOW;
  let onChain = false;
  let failures = opts.failCalls ?? 0;
  const calls: unknown[][] = [];
  const l = new LifecycleLocker({
    contractId: "arena.testnet",
    transport: {
      call: async (...a: unknown[]) => {
        calls.push(a);
        if (failures > 0) {
          failures--;
          throw new Error("x".repeat(1000));
        }
        if (!opts.neverLocks) onChain = true;
        return undefined;
      },
    },
    records: opts.records,
    now: () => clock,
    isLocked: async () => onChain,
    retryAfterMs: 30_000,
  });
  return { l, calls, setNow: (t: Date) => (clock = t), setOnChain: (v: boolean) => (onChain = v) };
}

const fresh = () =>
  new Map([
    ["1:0", rec("pass", inMs(600_000))],
    ["1:1", rec("pass", inMs(600_000))],
  ]);

describe("lifecycle lock step (fixture-only)", () => {
  it("locks when every community is approved and fresh, with a valid deposit", async () => {
    const t = locker({ records: fresh() });
    expect(await t.l.tryLock(1, 2, true)).toEqual({ status: "locked" });
    const [contract, method, args, gas, deposit] = t.calls[0]!;
    expect([contract, method, args]).toEqual(["arena.testnet", "lock_lifecycle_battle", { battle_id: 1, expected_communities: 2 }]);
    expect(String(gas)).toMatch(/Tgas/);
    // At least 1 yocto plus storage: a positive NEAR amount, refunded in part by the contract.
    expect(deposit).toBe(LOCK_DEPOSIT);
    expect(deposit).toMatch(/^[0-9.]+ NEAR$/);
  });

  it("does not lock when refresh is not ready or any record is missing, failed, expired or expiring", async () => {
    for (const [records, ready, reason] of [
      [fresh(), false, "refresh_not_ready"],
      [new Map([["1:0", rec("pass", inMs(600_000))]]), true, "community_1_missing"],
      [new Map([["1:0", rec("pass", inMs(600_000))], ["1:1", rec("pending", null)]]), true, "community_1_not_passed"],
      [new Map([["1:0", rec("pass", inMs(600_000))], ["1:1", rec("pass", null)]]), true, "community_1_no_expiry"],
      [new Map([["1:0", rec("pass", inMs(-1))], ["1:1", rec("pass", inMs(600_000))]]), true, "community_0_expiring"],
      [new Map([["1:0", rec("pass", inMs(59_000))], ["1:1", rec("pass", inMs(600_000))]]), true, "community_0_expiring"],
    ] as [Map<string, AuditRecord>, boolean, string][]) {
      const t = locker({ records });
      expect(await t.l.tryLock(1, 2, ready)).toEqual({ status: "not_ready", reason });
      expect(t.calls).toHaveLength(0);
    }
  });

  it("is idempotent: a locked battle is never sent again, including after a restart that finds it locked", async () => {
    const t = locker({ records: fresh() });
    await t.l.tryLock(1, 2, true);
    expect(await t.l.tryLock(1, 2, true)).toEqual({ status: "already_locked" });
    expect(t.calls).toHaveLength(1);
    const other = locker({ records: fresh() });
    other.setOnChain(true);
    expect(await other.l.tryLock(1, 2, true)).toEqual({ status: "already_locked" });
    expect(other.calls).toHaveLength(0);
  });

  it("returns a bounded error, backs off, and retries safely", async () => {
    const t = locker({ records: fresh(), failCalls: 1 });
    const first = await t.l.tryLock(1, 2, true);
    expect(first.status).toBe("failed");
    expect((first as { error: string }).error.length).toBeLessThanOrEqual(300);
    expect(await t.l.tryLock(1, 2, true)).toEqual({ status: "backoff" });
    expect(t.calls).toHaveLength(1);
    t.setNow(new Date(NOW.getTime() + 31_000));
    // Records must still be fresh at the retry time.
    t.setNow(new Date(NOW.getTime() + 31_000));
    expect(await t.l.tryLock(1, 2, true)).toEqual({ status: "locked" });
    expect(t.calls).toHaveLength(2);
  });

  it("reports an unconfirmed lock and re-reads the chain before retrying", async () => {
    const t = locker({ records: fresh(), neverLocks: true });
    expect(await t.l.tryLock(1, 2, true)).toEqual({ status: "unconfirmed" });
    t.setOnChain(true);
    t.setNow(new Date(NOW.getTime() + 31_000));
    expect(await t.l.tryLock(1, 2, true)).toEqual({ status: "already_locked" });
    expect(t.calls).toHaveLength(1);
  });

  it("an expired approval stops the lock until the pass refreshes it", async () => {
    const records = new Map<string, AuditRecord>();
    const calls: { method: string }[] = [];
    let onChain = false;
    let clock = NOW;
    const transport = {
      call: async (_c: string, method: string) => {
        calls.push({ method });
        if (method === "lock_lifecycle_battle") onChain = true;
      },
    };
    const community = {
      chain_id: "46630",
      token_address: TOKEN,
      representation: "aa.token.testnet",
      custody_domain: "vault-1",
      reference_chain_id: REF_CHAIN,
      reference_address: REF_TOKEN,
    };
    // The lock needs two funded communities.
    const view: LifecycleBattleView = { locked: false, communities: [community, community] };
    const pass = createLifecycleAuditPass({
      source: { count: async () => 1, get: async () => ({ ...view, locked: onChain }) },
      refresh: {
        policy: FIXTURE_RESOLVED,
        registry: staticReferenceRegistry(registry),
        now: () => clock,
        fetchGoPlus: async () => refGoplus(),
        fetchLp: async () => refLp("10001"),
        submitter: new AuditSubmitter("arena.testnet", transport as never),
        records,
      },
      lock: new LifecycleLocker({
        contractId: "arena.testnet",
        transport,
        records,
        now: () => clock,
        isLocked: async () => onChain,
      }),
    });
    expect(await pass()).toEqual({ checked: 1, ready: 1, errors: 0 });
    expect(calls.map((c) => c.method)).toEqual(["submit_lifecycle_audit", "submit_lifecycle_audit", "lock_lifecycle_battle"]);
    // Locked battles are skipped afterwards: no further calls.
    await pass();
    expect(calls).toHaveLength(3);
  });

  it("the pass sends no lock when the refreshed result is not a pass", async () => {
    const records = new Map<string, AuditRecord>();
    const calls: string[] = [];
    const transport = { call: async (_c: string, m: string) => void calls.push(m) };
    const pass = createLifecycleAuditPass({
      source: {
        count: async () => 1,
        get: async () => ({
          locked: false,
          communities: [
            {
              chain_id: "46630",
              token_address: TOKEN,
              representation: "aa.token.testnet",
              custody_domain: "vault-1",
              reference_chain_id: REF_CHAIN,
              reference_address: REF_TOKEN,
            },
          ],
        }),
      },
      refresh: {
        policy: FIXTURE_RESOLVED,
        registry: staticReferenceRegistry(registry),
        now: () => NOW,
        fetchGoPlus: async () => refGoplus(),
        fetchLp: async () => refLp("9999"),
        submitter: new AuditSubmitter("arena.testnet", transport as never),
        records,
      },
      lock: new LifecycleLocker({
        contractId: "arena.testnet",
        transport,
        records,
        now: () => NOW,
        isLocked: async () => false,
      }),
    });
    expect(await pass()).toEqual({ checked: 1, ready: 0, errors: 0 });
    expect(calls).toEqual(["submit_lifecycle_audit"]);
  });

  it("the lock is off unless AUDIT_LOCK_ENABLED=true", () => {
    const env = { AUDIT_ENABLED: "true", REFERENCE_RPC_URL: "https://rpc.example/mainnet" };
    expect(loadAuditConfig(env, 30)!.lockEnabled).toBe(false);
    expect(loadAuditConfig({ ...env, AUDIT_LOCK_ENABLED: "true" }, 30)!.lockEnabled).toBe(true);
  });
});
