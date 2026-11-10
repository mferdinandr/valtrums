import { describe, expect, it } from "vitest";
import { fetchGoPlusEvidence, inspectGoPlusEvidence, normalizeGoPlus } from "../src/goplus-audit.js";

describe("GoPlus normalization", () => {
  it("retains missing findings alongside critical rejection", () => {
    const result = normalizeGoPlus({ is_honeypot: "1", cannot_sell_all: "0", buy_tax: "0.05" });
    expect(result.decision).toBe("Reject");
    expect(result.findings).toContainEqual({ field: "cannot_sell_all", value: false, reason: "Clear" });
    expect(result.findings).toContainEqual({ field: "cannot_buy", value: null, reason: "Unknown flag" });
    expect(result.findings).toContainEqual({ field: "buy_tax", value: "0.05", reason: "Tax policy unresolved" });
  });

  it("rejects full tax and treats malformed fractions as unknown", () => {
    const result = normalizeGoPlus({ transfer_tax: "1.000", buy_tax: "1.01", sell_tax: "" });
    expect(result.decision).toBe("Reject");
    expect(result.findings.find((f) => f.field === "buy_tax")?.value).toBeNull();
    expect(result.findings.find((f) => f.field === "sell_tax")?.value).toBeNull();
  });

  it("holds clear fields pending and preserves empty owner", () => {
    const result = normalizeGoPlus({ is_honeypot: "0", cannot_sell_all: "0", cannot_buy: "0", owner_address: "" });
    expect(result.decision).toBe("Pending");
    expect(result.findings.find((f) => f.field === "owner_address")?.value).toBe("");
  });
});

describe("GoPlus provider request", () => {
  it("requests the bound source token and retains the response", async () => {
    const asset = { chainId: "4663", token: `0x${"ab".repeat(20)}`, representation: "token.testnet", custodyDomain: "custody", mappingVersion: "1" };
    let requested = "";
    const fetcher: typeof fetch = async (input) => {
      requested = String(input);
      return new Response('{"code":1,"result":{}}');
    };
    const evidence = await fetchGoPlusEvidence(asset, "policy-1", fetcher);
    expect(requested).toBe(`https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=${asset.token}`);
    expect(evidence.rawResponse).toBe('{"code":1,"result":{}}');
    expect(inspectGoPlusEvidence(asset, evidence).decision).toBe("Pending");
    await expect(fetchGoPlusEvidence({ ...asset, chainId: "../1" }, "policy-1", fetcher)).rejects.toThrow();
    await expect(fetchGoPlusEvidence(asset, "policy-1", async () => new Response("error", { status: 503 }))).rejects.toThrow("503");
  });
});

describe("GoPlus evidence identity", () => {
  const asset = { chainId: "46630", token: "0xabc", representation: "token.testnet", custodyDomain: "custody", mappingVersion: "1" };
  const evidence = {
    asset, queriedChainId: "46630", queriedToken: "0xAbC", provider: "GoPlus", apiVersion: "v1",
    queriedAt: "2026-11-07T00:00:00Z", policyVersion: "1",
    rawResponse: JSON.stringify({ code: 1, result: { "0xabc": { is_honeypot: "1" } } }),
  };
  it("binds findings and digest to the expected asset", () => {
    const result = inspectGoPlusEvidence(asset, evidence);
    expect(result.decision).toBe("Reject");
    expect(result.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(inspectGoPlusEvidence(asset, { ...evidence, queriedChainId: "1" }).decision).toBe("Pending");
    expect(inspectGoPlusEvidence({ ...asset, mappingVersion: "2" }, evidence).decision).toBe("Pending");
  });
  it("holds provider errors, wrong token results and malformed responses pending", () => {
    for (const rawResponse of ["{", '{"code":0,"result":{}}', '{"code":1,"result":{"0xdef":{"is_honeypot":"1"}}}']) {
      expect(inspectGoPlusEvidence(asset, { ...evidence, rawResponse }).decision).toBe("Pending");
    }
  });
});
