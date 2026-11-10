// FIXTURE-ONLY: a status object in memory. No oracle process, chain or provider.
import { describe, expect, it } from "vitest";
import { ApplicationReads, handleApplicationRead } from "../../src/mcp/application.js";
import { namespaceOf, type Deployment } from "../../src/mcp/application-contract.js";
import type { OracleStatus } from "../../src/lifecycle-oracle/status.js";

const cap = { enabled: true, reasons: ["recorded test support"] };
const deployment = (withOracle = true): Deployment => ({
  deploymentId: "testnet-a", network: "near-testnet", arenaContract: "arena.testnet", protocol: "lifecycle-v2", adapter: "fixture",
  companions: { payout: null, registry: null, backing: [] }, abi: { version: "lifecycle-application-v1", evidence: "recorded test", codeHash: null },
  capabilities: { battles: cap, detail: cap, assets: cap, audits: cap, ...(withOracle ? { oracle: cap } : {}) },
});
const status = (over: Partial<OracleStatus> = {}): OracleStatus => ({
  schema: "lifecycle-oracle-status-v1", updatedAtMs: "1000000", writesEnabled: true, accountId: "oracle.testnet", contract: "arena.testnet", passes: 4, passError: null,
  battles: { "7": { battleId: "7", phase: "pending_evidence", roundId: "1", reasons: ["coverage_incomplete: community 2: no closing sample"], actions: [], lastError: null, updatedAtMs: "1000000" } }, ...over,
});
const health = async (load: () => Promise<OracleStatus>, now = 1_010_000, d = deployment()) => {
  const s = new ApplicationReads([d], new Map([[d.deploymentId, { oracle: { namespace: namespaceOf(d), load, staleAfterMs: 60_000 } }]]), () => now);
  const out = await handleApplicationRead("GET", "health", new URLSearchParams({ deployment: "testnet-a", protocol: "lifecycle-v2" }), s);
  return JSON.parse(out.body);
};

describe("oracle status in application health", () => {
  it("exposes the current phase and pending reasons, labeled as the oracle's own report", async () => {
    const body = await health(async () => status());
    const oracle = body.data.components.oracle;
    expect(oracle.health).toBe("degraded");
    expect(oracle.reasons.join(" ")).toMatch(/oracle's own report, not chain authority/);
    expect(oracle.reasons.join(" ")).toMatch(/battle 7 pending_evidence: coverage_incomplete/);
    expect(oracle.details).toMatchObject({ passes: 4, stale: false, battles: [{ battleId: "7", phase: "pending_evidence" }] });
  });

  it("flags a stale status, a pass error and dry run", async () => {
    const stale = await health(async () => status({ writesEnabled: false, passError: "rpc down" }), 5_000_000);
    expect(stale.data.components.oracle.details.stale).toBe(true);
    expect(stale.data.components.oracle.reasons.join(" ")).toMatch(/stale.*oracle process may be down/);
    expect(stale.data.components.oracle.reasons.join(" ")).toMatch(/oracle pass error: rpc down/);
    expect(stale.data.components.oracle.reasons.join(" ")).toMatch(/writes are disabled/);
  });

  it("is unavailable, never healthy, when the status is missing or unreadable, and when not declared", async () => {
    const missing = await health(async () => { throw new Error("ENOENT"); });
    expect(missing.data.components.oracle).toMatchObject({ health: "unavailable" });
    const undeclared = await health(async () => status(), 1_010_000, deployment(false));
    expect(undeclared.data.components.oracle.health).toBe("unavailable");
    expect(undeclared.data.components.oracle.reasons.join(" ")).toMatch(/not declared/);
  });

  it("rejects an oracle status bound to another namespace", () => {
    const d = deployment();
    expect(() => new ApplicationReads([d], new Map([[d.deploymentId, { oracle: { namespace: { ...namespaceOf(d), deploymentId: "other" }, load: async () => status(), staleAfterMs: 1 } }]]))).toThrow(/foreign oracle status binding/);
  });
});
