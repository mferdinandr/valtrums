import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DANGEROUS_PRIVILEGES, STRICT_AUDIT_POLICY_VERSION, type GoPlusEvidence, type LiquidityDepthEvidence } from "../src/arena-audit.js";
import { runArenaAuditPass, type ArenaAuditBattleSnapshot, type ArenaAuditProviders,
  type ArenaAuditStage, type ArenaAuditSubmission, type StoredArenaAudit, type TargetArenaAuditClient } from "../src/arena-audit-runner.js";

const now = 1_000_000;
const asset = (n: number) => ({ chainId: "46630", tokenAddress: "0x" + n.toString(16).padStart(40, "0") });
function battle(size = 2): ArenaAuditBattleSnapshot {
  return { battleId: "1", version: "1", status: "Proposed", chainNowNs: "1000000000000", gatheringDeadlineNs: "1000000000000",
    policy: { version: STRICT_AUDIT_POLICY_VERSION, maxEvidenceAgeMs: 60000 },
    communities: Array.from({ length: size }, (_, n) => ({ communityId: `coin-${n}`, mappingVersion: "1", asset: asset(n + 1) })) };
}
function security(a: ReturnType<typeof asset>, changes: Record<string, unknown> = {}): GoPlusEvidence {
  const fields = { is_honeypot: "0", cannot_sell_all: "0", cannot_buy: "0", buy_tax: "0", sell_tax: "0", transfer_tax: "0",
    ...Object.fromEntries(DANGEROUS_PRIVILEGES.map(field => [field, "0"])),
    is_open_source: "1", is_proxy: "0", is_mintable: "0", ...changes };
  const rawResponse = { code: 1, result: { [a.tokenAddress]: fields } };
  return { ...a, provider: "goplus-token-security-v1", origin: "live", observedAtMs: now, available: true, fields, rawResponse,
    responseHash: createHash("sha256").update(JSON.stringify(rawResponse)).digest("hex") };
}
function lp(a: ReturnType<typeof asset>): LiquidityDepthEvidence {
  return { ...a, provider: "independent-dex", origin: "live", observedAtMs: now,
    valueUsd: "10001", poolIds: ["pool-for-" + a.tokenAddress], blockHash: "source-block" };
}
class Client implements TargetArenaAuditClient {
  view: ArenaAuditBattleSnapshot | null = battle();
  records = new Map<ArenaAuditStage, StoredArenaAudit>();
  submitted: ArenaAuditSubmission[] = [];
  forceStale = false;
  async getBattle() { return this.view; }
  async getAudit(_id: string, stage: ArenaAuditStage) { return this.records.get(stage) ?? null; }
  async submitAudit(submission: ArenaAuditSubmission): Promise<"Recorded" | "Duplicate" | "Stale"> {
    if (this.forceStale || this.view?.version !== submission.expectedBattleVersion
      || !["Proposed", "Approved", "Gathering"].includes(this.view.status)) return "Stale";
    if (this.records.get(submission.stage)?.idempotencyKey === submission.idempotencyKey) return "Duplicate";
    this.records.set(submission.stage, structuredClone(submission));
    this.submitted.push(submission);
    return "Recorded";
  }
}
function setup(size = 2) {
  const client = new Client();client.view = battle(size);
  const reads: string[] = [];
  const providers: ArenaAuditProviders = {
    goPlus: { async audit(a) { reads.push(a.tokenAddress);return security(a); } },
    liquidity: { async getDepth(a) { return lp(a); } },
  };
  const pass = (mode: "live" | "fixture" = "live", time = now) => runArenaAuditPass({ battleId: "1", client, providers, evidenceMode: mode, nowMs: () => time });
  return { client, providers, reads, pass };
}

describe("target arena audit pass", () => {
  it.each([2, 3])("audits every one of %s communities and emits JSON-safe policy-bound evidence", async count => {
    const { client, reads, pass } = setup(count);
    const result = await pass();
    expect(result.action).toBe("Recorded");expect(result.decision).toBe("Pass");
    expect(reads).toHaveLength(count);
    expect(client.submitted[0]?.communities).toHaveLength(count);
    expect(client.submitted[0]?.policyVersion).toBe(STRICT_AUDIT_POLICY_VERSION);
    expect(() => JSON.stringify(client.submitted[0])).not.toThrow();
  });
  it("requires all communities to pass and preserves Reject over another token's Pending", async () => {
    const { providers, pass } = setup(3);
    providers.goPlus.audit = async a => security(a, a.tokenAddress === asset(1).tokenAddress ? { is_honeypot: "1" }
      : a.tokenAddress === asset(2).tokenAddress ? { sell_tax: "" } : {});
    const result = await pass();
    expect(result.decision).toBe("Reject");
    expect(result.submission?.communities.map(c => c.decision)).toEqual(["Reject", "Pending", "Pass"]);
  });
  it("turns provider exceptions into per-token Pending evidence without leaking secret errors", async () => {
    const { providers, pass } = setup();
    providers.liquidity.getDepth = a => { if (a.tokenAddress === asset(1).tokenAddress) throw new Error("secret-provider-token");return Promise.resolve(lp(a)); };
    const result = await pass();
    expect(result.decision).toBe("Pending");
    expect(result.submission?.communities[0]?.findings).toContainEqual(expect.objectContaining({ field: "liquidity", decision: "Pending" }));
    expect(JSON.stringify(result)).not.toContain("secret-provider-token");
  });
  it("does not let an authority-provider failure silently pass", async () => {
    const { providers, pass } = setup();
    providers.authority = { async getAuthority() { throw new Error("RPC failure"); } };
    expect((await pass()).decision).toBe("Pending");
  });
  it("records malformed fulfilled provider evidence as Pending", async () => {
    const { providers, pass } = setup();
    providers.goPlus.audit = async () => null as unknown as GoPlusEvidence;
    providers.liquidity.getDepth = async () => ({}) as LiquidityDepthEvidence;
    expect((await pass()).decision).toBe("Pending");
  });
  it("rejects fixture approval in live mode and makes fixture-mode decisions explicit", async () => {
    const { providers, pass, client } = setup();
    providers.goPlus.audit = async a => ({ ...security(a), origin: "fixture" });
    expect((await pass()).decision).toBe("Pending");
    expect((await pass("fixture")).decision).toBe("Pass");
    expect(client.submitted[1]?.evidenceMode).toBe("fixture");
    expect(client.submitted[1]?.communities.every(c => c.origins.includes("fixture"))).toBe(true);
  });
  it("deduplicates fresh success across new worker calls using durable contract records", async () => {
    const { client, reads, providers, pass } = setup();
    await pass();
    const again = await runArenaAuditPass({ battleId: "1", client, providers, evidenceMode: "live", nowMs: () => now + 1 });
    expect(again.action).toBe("Duplicate");expect(reads).toHaveLength(2);expect(client.submitted).toHaveLength(1);
  });
  it("retries unchanged Pending evidence without repeated submissions", async () => {
    const { providers, client, pass } = setup();
    providers.goPlus.audit = async a => security(a, { sell_tax: "" });
    await pass();
    expect((await pass("live", now + 1)).action).toBe("Duplicate");
    expect(client.submitted).toHaveLength(1);
    providers.goPlus.audit = async a => security(a);
    expect((await pass("live", now + 2)).decision).toBe("Pass");
    expect(client.submitted).toHaveLength(2);
  });
  it("rechecks mapping and policy changes even while previous audit is fresh", async () => {
    const { client, reads, pass } = setup();await pass();
    client.view!.communities[0]!.mappingVersion = "2";
    expect((await pass()).action).toBe("Recorded");
    client.view!.policy.version = "next-strict-policy";
    expect((await pass()).action).toBe("Recorded");
    expect(reads).toHaveLength(6);
    expect(new Set(client.submitted.map(s => s.snapshotHash)).size).toBe(3);
  });
  it("refreshes expired durable audits and keeps expired source evidence Pending", async () => {
    const { pass, reads } = setup();await pass();
    const result = await pass("live", now + 60001);
    expect(reads).toHaveLength(4);expect(result.decision).toBe("Pending");expect(result.submission?.expiresAtMs).toBe(0);
  });
  it("uses chain time for the creator deadline, never caller tick time", async () => {
    const { client, reads, pass } = setup();client.view!.status = "Approved";
    client.view!.chainNowNs = "999999999999";
    expect((await pass("live", now + 90000000)).action).toBe("Skipped");
    expect(reads).toHaveLength(0);
    client.view!.chainNowNs = client.view!.gatheringDeadlineNs!;
    expect((await pass()).stage).toBe("PreLock");
    expect(client.view!.gatheringDeadlineNs).toBe("1000000000000");
  });
  it("requires fresh pre-lock evidence independently of successful proposal evidence", async () => {
    const { client, reads, pass, providers } = setup();await pass();
    client.view!.status = "Approved";
    providers.liquidity.getDepth = async a => ({ ...lp(a), valueUsd: "10000" });
    const result = await pass();
    expect(reads).toHaveLength(4);expect(result.stage).toBe("PreLock");expect(result.decision).toBe("Reject");
  });
  it.each(["Locked", "Live", "Overtime", "Settling", "Settled", "Voided"] as const)("never audits/halts/refunds a %s battle", async status => {
    const { client, providers, pass, reads } = setup();client.view!.status = status;
    providers.liquidity.getDepth = async () => { throw new Error("LP fell"); };
    expect((await pass()).action).toBe("Skipped");expect(reads).toHaveLength(0);expect(client.submitted).toHaveLength(0);
  });
  it("reports an atomic contract stale response when configuration changes during acquisition", async () => {
    const { client, providers, pass } = setup();
    providers.goPlus.audit = async a => { client.view!.version = "2";return security(a); };
    const result = await pass();expect(result.action).toBe("Stale");
    expect(result.submission?.expectedBattleVersion).toBe("1");expect(client.submitted).toHaveLength(0);
  });
  it("propagates submission failure so an unrecorded audit is never claimed successful", async () => {
    const { client, pass } = setup();client.submitAudit = async () => { throw new Error("transaction unavailable"); };
    await expect(pass()).rejects.toThrow("transaction unavailable");
  });
  it("refuses duplicate token identities and missing pre-lock deadlines", async () => {
    const { client, pass } = setup();client.view!.communities[1]!.asset = asset(1);
    await expect(pass()).rejects.toThrow("Duplicate community");
    client.view = battle();client.view.status = "Approved";client.view.gatheringDeadlineNs = null;
    await expect(pass()).rejects.toThrow("lacks creator deadline");
  });
});
