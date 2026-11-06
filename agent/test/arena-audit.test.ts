import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GoPlusArenaClient, evaluateArenaAudit, parseAuditDecimal, normalizeAuditFlag,
  DANGEROUS_PRIVILEGES, STRICT_AUDIT_POLICY_VERSION,
  type GoPlusEvidence, type LiquidityDepthEvidence, type AuthorityEvidence,
} from "../src/arena-audit.js";
import type { HttpClient } from "../src/http.js";

const asset = { chainId: "46630", tokenAddress: "0x1234567890abcdef1234567890abcdef12345678" };
const now = 1_000_000;
const policy = { version: STRICT_AUDIT_POLICY_VERSION, maxEvidenceAgeMs: 60_000 };
const fields = () => ({
  is_honeypot: "0", cannot_sell_all: "0", cannot_buy: "0",
  buy_tax: "0.05", sell_tax: "0.000", transfer_tax: "0",
  ...Object.fromEntries(DANGEROUS_PRIVILEGES.map(key => [key, "0"])),
  is_open_source: "1", is_proxy: "0", is_mintable: "0", owner_address: "",
});
function goPlus(changes: Record<string, unknown> = {}): GoPlusEvidence {
  const data = { ...fields(), ...changes };
  const rawResponse = { code: 1, result: { [asset.tokenAddress]: data } };
  return { ...asset, provider: "goplus-token-security-v1", origin: "fixture", observedAtMs: now,
    available: true, fields: data, rawResponse,
    responseHash: createHash("sha256").update(JSON.stringify(rawResponse)).digest("hex") };
}
function liquidity(valueUsd = "10001"): LiquidityDepthEvidence {
  return { ...asset, provider: "independent-dex-pool", origin: "fixture", observedAtMs: now,
    valueUsd, poolIds: ["pool-1"], blockHash: "source-block-hash" };
}
function evaluate(g = goPlus(), lp: LiquidityDepthEvidence | null = liquidity(), authority?: Parameters<typeof evaluateArenaAudit>[0]["authority"]) {
  return evaluateArenaAudit({ asset, goPlus: g, liquidity: lp, policy, nowMs: now, authority });
}
function authority(active: AuthorityEvidence["active"]): AuthorityEvidence {
  return { ...asset, provider: "authority-verifier", origin: "fixture", observedAtMs: now,
    active, evidenceReference: "verified-role-state-at-source-block" };
}

describe("arena audit exact normalization", () => {
  it("never interprets string zero as truthy and preserves unknown values", () => {
    expect(normalizeAuditFlag("0")).toBe(false);
    expect(normalizeAuditFlag("1")).toBe(true);
    for (const value of [false, true, 0, 1, "", null, undefined, "false"]) expect(normalizeAuditFlag(value)).toBeNull();
  });
  it("retains sub-basis-point precision without floating point", () => {
    const value = parseAuditDecimal("0.050000000000000001");
    expect(value).toEqual({ numerator: 50000000000000001n, denominator: 1000000000000000000n });
    for (const value of [0.05, ".05", "5e-2", "-1", "01", " 0", "NaN", "", "1".repeat(121)]) expect(parseAuditDecimal(value)).toBeNull();
  });
});

describe("pre-lock strict arena eligibility", () => {
  it("passes a clear fixed-supply token at exactly 5% tax with adequate independent LP", () => {
    const result = evaluate();
    expect(result.decision).toBe("Pass");
    expect(result.origins).toEqual(["fixture"]);
    expect(result.policyVersion).toBe(policy.version);
  });
  it("rejects tax just beyond 5%, preserving full decimal precision", () => {
    const result = evaluate(goPlus({ buy_tax: "0.050000000000000001" }));
    expect(result.decision).toBe("Reject");
    expect(result.findings).toContainEqual(expect.objectContaining({ field: "buy_tax", decision: "Reject" }));
  });
  it.each(["buy_tax", "sell_tax", "transfer_tax"])("rejects entirely taxed %s", field => {
    expect(evaluate(goPlus({ [field]: "1" })).decision).toBe("Reject");
  });
  it("requires transfer tax exactly zero and treats malformed fractions as unknown", () => {
    expect(evaluate(goPlus({ transfer_tax: "0.000000000000000001" })).decision).toBe("Reject");
    for (const field of ["buy_tax", "sell_tax", "transfer_tax"]) {
      for (const value of ["", null, "1.1", "-0.01", "oops"]) {
        const result = evaluate(goPlus({ [field]: value }));
        expect(result.decision).toBe("Pending");
        expect(result.normalizedTaxes[field]).toBeNull();
      }
    }
  });
  it("does not let incomplete fields hide a confirmed honeypot", () => {
    const result = evaluate(goPlus({ is_honeypot: "1", sell_tax: "" }));
    expect(result.decision).toBe("Reject");
    expect(result.findings.map(f => f.decision)).toContain("Pending");
  });
  it("rejects inability to sell all without inferring all sale transactions fail", () => {
    expect(evaluate(goPlus({ cannot_sell_all: "1" })).decision).toBe("Reject");
  });
  it("rejects active dangerous authority; requires independent proof for inactive authority", () => {
    for (const field of DANGEROUS_PRIVILEGES) {
      const evidence = goPlus({ [field]: "1", owner_address: "" });
      expect(evaluate(evidence).decision).toBe("Pending");
      expect(evaluate(evidence, liquidity(), { [field]: authority("unknown") }).decision).toBe("Pending");
      expect(evaluate(evidence, liquidity(), { [field]: authority(true) }).decision).toBe("Reject");
      expect(evaluate(evidence, liquidity(), { [field]: authority(false) }).decision).toBe("Pass");
      expect(evaluate(evidence, liquidity(), { [field]: { ...authority(false), tokenAddress: "0x" + "a".repeat(40) } }).decision).toBe("Pending");
    }
  });
  it("holds unsupported mint/proxy policy and absent capability checks Pending", () => {
    for (const change of [{ is_mintable: "1" }, { is_proxy: "1" }, { transfer_pausable: null }, { is_open_source: null }]) {
      expect(evaluate(goPlus(change)).decision).toBe("Pending");
    }
  });
  it.each(["9999", "10000", "10000.000000000000000000"])("rejects LP %s", value => {
    expect(evaluate(goPlus(), liquidity(value)).decision).toBe("Reject");
  });
  it("accepts independent LP strictly above threshold without quantizing", () => {
    expect(evaluate(goPlus(), liquidity("10000.000000000000000001")).decision).toBe("Pass");
  });
  it("never uses GoPlus pool context as independent LP proof", () => {
    expect(evaluate(goPlus({ dex: [{ liquidity: "9999999" }] }), null).decision).toBe("Pending");
    expect(evaluate(goPlus(), { ...liquidity(), provider: "goplus-token-security-v1" }).decision).toBe("Pending");
    expect(evaluate(goPlus(), { ...liquidity(), poolIds: ["pool-1", "pool-1"] }).decision).toBe("Pending");
  });
  it("holds wrong chain/token, future and expired evidence rather than using its critical result", () => {
    for (const changes of [{ chainId: "4663" }, { tokenAddress: "0x" + "f".repeat(40) }, { observedAtMs: now + 1 }, { observedAtMs: now - 60001 }]) {
      expect(evaluate({ ...goPlus({ is_honeypot: "1" }), ...changes }).decision).toBe("Pending");
      expect(evaluate(goPlus(), { ...liquidity(), ...changes }).decision).toBe("Pending");
    }
    expect(evaluate({ ...goPlus(), observedAtMs: now - 60000 }).decision).toBe("Pass");
  });
  it("refuses altered raw evidence and separately substituted normalized fields", () => {
    const evidence = goPlus();
    expect(evaluate({ ...evidence, responseHash: "untrusted-hash" }).decision).toBe("Pending");
    expect(evaluate({ ...evidence, fields: { ...fields(), buy_tax: "0" } }).decision).toBe("Pending");
  });
  it("requires explicit freshness bounds and source identity", () => {
    expect(() => evaluateArenaAudit({ asset, goPlus: goPlus(), liquidity: liquidity(), policy: { version: "", maxEvidenceAgeMs: 1 }, nowMs: now })).toThrow();
    expect(() => evaluateArenaAudit({ asset: { ...asset, tokenAddress: "NEAR-wrapper.testnet" }, goPlus: goPlus(), liquidity: liquidity(), policy, nowMs: now })).toThrow();
  });
});

describe("GoPlus source-token HTTP adapter", () => {
  it("discovers function-specific chain support and binds the requested token", async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const http: HttpClient = { async getJson(url, headers) {
      calls.push({ url, headers });
      return calls.length === 1 ? { code: 1, result: [{ id: "46630" }] } : goPlus().rawResponse;
    } };
    const client = new GoPlusArenaClient(http, { now: () => now, bearerToken: "secret", origin: "fixture" });
    const result = await client.audit({ ...asset, tokenAddress: asset.tokenAddress.toUpperCase().replace("0X", "0x") });
    expect(result.available).toBe(true);
    expect(calls[0]?.url).toContain("supported_chains?name=token_security");
    expect(calls[1]?.url).toContain(`token_security/46630?contract_addresses=${asset.tokenAddress}`);
    expect(calls[1]?.headers).toEqual({ Authorization: "Bearer secret" });
    expect(evaluate(result).decision).toBe("Pass");
  });
  it("accepts unambiguous alternate chain_id spelling but rejects conflicting IDs", async () => {
    for (const [row, expected] of [[{ chain_id: asset.chainId }, true], [{ id: "1", chain_id: asset.chainId }, false]] as const) {
      const client = new GoPlusArenaClient({ async getJson(url) {
        return url.includes("supported_chains") ? { code: 1, result: [row] } : goPlus().rawResponse;
      } });
      expect((await client.audit(asset)).available).toBe(expected);
    }
  });
  it("does not request token security on an unsupported network", async () => {
    const calls: string[] = [];
    const client = new GoPlusArenaClient({ async getJson(url) { calls.push(url); return { code: 1, result: [{ chain_id: "1" }] }; } });
    const evidence = await client.audit(asset);
    expect(calls).toHaveLength(1);
    expect(evidence.available).toBe(false);
    expect(evaluate(evidence).decision).toBe("Pending");
  });
  it.each([{ code: 0, result: [] }, { code: 1, result: null }])("holds incomplete supported-chain discovery", async payload => {
    const evidence = await new GoPlusArenaClient({ async getJson() { return payload; } }).audit(asset);
    expect(evidence.available).toBe(false);
  });
  it("requires a requested-token result and never leaks provider error details", async () => {
    const client = new GoPlusArenaClient({ async getJson(url) {
      if (url.includes("supported_chains")) return { code: 1, result: [{ chain_id: asset.chainId }] };
      return { code: 1, result: { ["0x" + "f".repeat(40)]: fields() } };
    } });
    expect((await client.audit(asset)).available).toBe(false);
    const failing = new GoPlusArenaClient({ async getJson() { throw new Error("secret-credential-url"); } });
    const evidence = await failing.audit(asset);
    expect(evidence.unavailableReason).toBe("GoPlus request failed");
    expect(JSON.stringify(evidence)).not.toContain("secret-credential");
  });
  it("refuses insecure endpoints and invalid asset identifiers", async () => {
    const http: HttpClient = { async getJson() { throw new Error("unused"); } };
    expect(() => new GoPlusArenaClient(http, { endpoint: "http://localhost" })).toThrow();
    await expect(new GoPlusArenaClient(http).audit({ ...asset, chainId: "46630/path" })).rejects.toThrow();
  });
});
