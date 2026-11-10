// FIXTURE-ONLY: synthetic addresses and operator facts. Not a statement about any deployed contract.
import { describe, expect, it } from "vitest";
import { ApplicationReads, handleApplicationRead } from "../../src/mcp/application.js";
import { namespaceOf, type Deployment } from "../../src/mcp/application-contract.js";
import { loadCustodyPaths } from "../../src/mcp/custody-config.js";

const cap = { enabled: true, reasons: ["recorded test support"] };
const A = (n: string) => `0x${n.repeat(40)}`;
const deployment = (declared = true): Deployment => ({
  deploymentId: "testnet-a", network: "near-testnet", arenaContract: "arena.testnet", protocol: "lifecycle-v2", adapter: "fixture",
  companions: { payout: null, registry: null, backing: [] }, abi: { version: "lifecycle-application-v1", evidence: "recorded test", codeHash: null },
  capabilities: { battles: cap, detail: cap, assets: cap, audits: cap, ...(declared ? { custody: cap } : {}) },
});
const path = (label: string, over: Record<string, unknown> = {}) => ({ label, depositContract: A("c"), tokenHolder: A("a"), payoutSender: A("a"), holderCodeHash: null, ...over });
const health = async (paths: ReturnType<typeof path>[] | null, d = deployment()) => {
  const s = new ApplicationReads([d], new Map([[d.deploymentId, paths === null ? {} : { custody: { namespace: namespaceOf(d), paths } }]]), () => 1);
  return JSON.parse((await handleApplicationRead("GET", "health", new URLSearchParams({ deployment: "testnet-a", protocol: "lifecycle-v2" }), s)).body).data.components.custody;
};

describe("custody gate in application health", () => {
  it("keeps source transfers disabled when no path is configured or the capability is not declared", async () => {
    const none = await health(null);
    expect(none.health).toBe("unavailable");
    expect(none.reasons.join(" ")).toMatch(/no custody path configured: source-chain transfers and payouts stay disabled/);
    expect((await health(null, deployment(false))).reasons.join(" ")).toMatch(/not declared/);
    const empty = await health([]);
    expect(empty.details).toMatchObject({ sourceTransfersEnabled: false, paths: [] });
    expect(empty.reasons.join(" ")).toMatch(/no custody path is configured/);
  });

  it("detects deposit-only custody: tokens kept in the deposit contract keep transfers disabled", async () => {
    const c = await health([path("old-deposit-contract", { tokenHolder: A("c"), holderCodeHash: "0x" + "11".repeat(32) })]);
    expect(c.details.sourceTransfersEnabled).toBe(false);
    expect(c.details.paths[0]).toMatchObject({ label: "old-deposit-contract", spendable: false });
    expect(c.reasons.join(" ")).toMatch(/old-deposit-contract: tokens are held by .* the signing account cannot spend them/);
  });

  it("enables transfers only when every configured path is spendable, and still says it is not a live proof", async () => {
    const ok = await health([path("forwarder-a"), path("forwarder-b", { tokenHolder: A("b"), payoutSender: A("b") })]);
    expect(ok.details.sourceTransfersEnabled).toBe(true);
    expect(ok.health).toBe("degraded"); // never healthy: operator-asserted facts, not a payout proof
    expect(ok.reasons.join(" ")).toMatch(/not a live payout proof/);
    const mixed = await health([path("good"), path("bad", { tokenHolder: A("b") })]);
    expect(mixed.details.sourceTransfersEnabled).toBe(false);
    expect(mixed.details.paths.map((p: { spendable: boolean }) => p.spendable)).toEqual([true, false]);
  });

  it("never assumes a signing key controls a contract-code holder", async () => {
    const c = await health([path("contract-holder", { holderCodeHash: "0x" + "22".repeat(32) })]);
    expect(c.details.sourceTransfersEnabled).toBe(false);
    expect(c.reasons.join(" ")).toMatch(/has not been reviewed as spendable/);
  });

  it("rejects a custody binding for another namespace", () => {
    const d = deployment();
    expect(() => new ApplicationReads([d], new Map([[d.deploymentId, { custody: { namespace: { ...namespaceOf(d), deploymentId: "other" }, paths: [] } }]]))).toThrow(/foreign custody binding/);
  });
});

describe("custody path configuration", () => {
  it("parses valid paths and fails startup on anything malformed", () => {
    expect(loadCustodyPaths(JSON.stringify([path("a")]))).toHaveLength(1);
    expect(() => loadCustodyPaths("nope")).toThrow(/valid JSON/);
    expect(() => loadCustodyPaths(JSON.stringify([path("a", { tokenHolder: "0x12" })]))).toThrow(/array of custody path objects/);
    expect(() => loadCustodyPaths(JSON.stringify([{ ...path("a"), extra: 1 }]))).toThrow(/array of custody path objects/);
    expect(() => loadCustodyPaths(JSON.stringify([path("a"), path("a")]))).toThrow(/duplicate label/);
  });
});
