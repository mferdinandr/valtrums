// Recorded fixtures only; no live provider or deployed ABI evidence.
import { describe, expect, it, vi } from "vitest";
import { ApplicationReads, handleApplicationRead, type ApplicationBinding } from "../../src/mcp/application.js";
import { integer, manifestSchema, namespaceOf, type Deployment } from "../../src/mcp/application-contract.js";
import { battleSchema } from "../../src/mcp/application-adapter.js";
import { FixtureArenaReadSource, NearArenaReadSource } from "../../src/mcp/read-source.js";
import { staticReferenceRegistry } from "../../src/reference-registry.js";
import { InMemoryReportArchive } from "../../src/audit/report-archive.js";
import { buildAuditReport } from "../../src/audit/report.js";
import { evaluateCommunity } from "../../src/audit/decision.js";
import { FIXTURE_RESOLVED, NOW as AUDIT_NOW, asset, goplus, lp } from "../audit/fixtures.js";
import { battle, makeSource, NOW, makeDeps } from "./fixtures.js";
import { handleReadRequest } from "../../src/mcp/http.js";

const capability = { enabled: true, reasons: ["recorded test support"] };
export const deployment = (over: Partial<Deployment> = {}): Deployment => ({
  deploymentId: "arena-fixture-v1", network: "near-testnet", arenaContract: "arena.testnet", protocol: "lifecycle-v2", adapter: "fixture",
  companions: { payout: null, registry: "arena.testnet", backing: [] }, abi: { version: "source-abi-v1", evidence: "recorded source inspection", codeHash: null },
  capabilities: { battles: capability, detail: capability, assets: capability, audits: capability }, ...over,
});
const params = (d = deployment(), extra: Record<string, string> = {}) => new URLSearchParams({ deployment: d.deploymentId, protocol: d.protocol, ...extra });
const invoke = async (s: ApplicationReads, path = "battles", p = params()) => {
  const out = await handleApplicationRead("GET", path, p, s);
  return { status: out.status, body: JSON.parse(out.body) };
};
const service = (d = deployment(), binding: ApplicationBinding = { source: makeSource() }) => new ApplicationReads([d], new Map([[d.deploymentId, binding]]), () => NOW);

describe("application boundary", () => {
  it("preserves exact integers and rejects rounded, signed, exponent and overflowing boundaries", () => {
    expect(integer("18446744073709551615")).toBe("18446744073709551615");
    expect(integer("340282366920938463463374607431768211455", 128)).toHaveLength(39);
    for (const v of [9007199254740992, -1, "01", "1e3", "18446744073709551616"]) expect(() => integer(v)).toThrow();
    expect(() => battleSchema.parse(battle({ principal_amount: 9007199254740992 as unknown as string }))).toThrow();
  });
  it("validates manifests and refuses fixture substitution for RPC", () => {
    expect(() => manifestSchema.parse([deployment(), deployment()])).toThrow();
    expect(() => manifestSchema.parse([{ ...deployment(), upstream: "https://evil" }])).toThrow();
    expect(() => service(deployment({ adapter: "rpc" }))).toThrow("source does not match");
  });
  it("returns decimal IDs, honest fixture labels, bounded defaults and backend filtering", async () => {
    const s = service();
    const res = await invoke(s, "battles", params(undefined, { status: "decided" }));
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((b: { battleId: string }) => b.battleId)).toEqual(["2"]);
    expect(res.body.provenance).toMatchObject({ kind: "fixture", observedAtMs: null, fetchedAtMs: String(NOW), finality: "not-applicable", complete: false });
    const invalidQueries: Record<string, string>[] = [{ limit: "51" }, { q: "x".repeat(65) }, { status: "fake" }, { url: "http://evil" }];
    for (const extra of invalidQueries) {
      expect((await invoke(s, "battles", params(undefined, extra))).status).toBe(400);
    }
    const duplicate = params(); duplicate.append("protocol", "lifecycle-v2");
    expect((await invoke(s, "battles", duplicate)).status).toBe(400);
  });
  it("binds cursors to full deployment, protocol, filters, ABI and snapshot", async () => {
    const d1 = deployment(); const d2 = deployment({ deploymentId: "other-v1", arenaContract: "other.testnet" });
    const s = new ApplicationReads([d1, d2], new Map([[d1.deploymentId, { source: makeSource() }], [d2.deploymentId, { source: makeSource() }]]));
    const first = await invoke(s, "battles", params(d1, { limit: "1" }));
    const cursor = first.body.data.nextCursor;
    expect((await invoke(s, "battles", params(d1, { limit: "1", cursor }))).body.data.items[0].battleId).toBe("2");
    expect((await invoke(s, "battles", params(d2, { limit: "1", cursor }))).status).toBe(400);
    expect((await invoke(s, "battles", params(d1, { limit: "1", cursor, q: "pepe" }))).status).toBe(400);
    expect((await invoke(s, "battles", new URLSearchParams({ deployment: d1.deploymentId, protocol: "legacy-v1", cursor }))).status).toBe(400);
    const source = makeSource(); const changed = service(d1, { source });
    const page = await invoke(changed, "battles", params(d1, { limit: "1" }));
    vi.spyOn(source, "battle").mockResolvedValue(battle());
    expect((await invoke(changed, "battles", params(d1, { limit: "1", cursor: page.body.data.nextCursor }))).body.error.code).toBe("snapshot_changed");
  });
  it("rejects unsafe ID before lookup and reports outages without zero/demo data", async () => {
    const source = makeSource(); const lookup = vi.spyOn(source, "battle");
    expect((await invoke(service(undefined, { source }), "battles/9007199254740993")).status).toBe(422);
    expect(lookup).not.toHaveBeenCalled();
    vi.spyOn(source, "battleCount").mockRejectedValue(new Error("secret RPC url"));
    const failed = await invoke(service(undefined, { source }));
    expect(failed.status).toBe(503); expect(failed.body.data).toBeUndefined(); expect(JSON.stringify(failed)).not.toContain("secret");
    const rpc = new NearArenaReadSource({ network: "near-testnet", kind: "live", name: "arena.testnet" }, async () => 9007199254740992, { arena: "arena.testnet", payout: null });
    const unsafe = await invoke(service(deployment({ adapter: "rpc" }), { source: rpc }));
    expect(unsafe.status).toBe(422); expect(unsafe.body.error.code).toBe("unsupported_boundary");
  });
  it("keeps battle detail partial when the current round fails", async () => {
    const source = makeSource(); vi.spyOn(source, "round").mockRejectedValue(new Error("offline"));
    const result = await invoke(service(undefined, { source }), "battles/2");
    expect(result.status).toBe(200); expect(result.body.data.round).toBeNull();
    expect(result.body.provenance.reasons).toContain("current round read failed");
  });
  it("searches the trusted registry with pending eligibility and refuses registry outages", async () => {
    const registry = staticReferenceRegistry([{ chainId: "46630", token: "0x" + "a".repeat(40), referenceChainId: "4663", referenceToken: "0x" + "b".repeat(40) }]);
    const s = service(undefined, { registry });
    const result = await invoke(s, "assets", params(undefined, { q: "46630" }));
    expect(result.body.data.items[0]).toMatchObject({ eligibility: "notEstablished", registryVersion: "1" });
    expect((await invoke(s, "assets", params(undefined, { q: "no-match" }))).body.data.items).toEqual([]);
    vi.spyOn(registry, "load").mockRejectedValue(new Error("offline"));
    expect((await invoke(s, "assets")).status).toBe(503);
  });
  it("requires explicit archive scope, filters foreign arenas, preserves expired history", async () => {
    const archive = new InMemoryReportArchive(); const d = deployment();
    expect((await invoke(service(), "battles/1/audits")).status).toBe(422);
    expect(() => service(d, { audits: { archive, namespace: namespaceOf(deployment({ network: "near-mainnet" })) } })).toThrow();
    const s = service(d, { audits: { archive, namespace: namespaceOf(d) } });
    expect((await invoke(s, "battles/1/audits")).body.data.state).toBe("missing");
    const report = buildAuditReport(evaluateCommunity({ asset, goplus: goplus(), lp: lp("10001"), policy: FIXTURE_RESOLVED, now: AUDIT_NOW }));
    await archive.put({ report, attribution: { arena: d.arenaContract, battleId: 1, community: 0 }, provenance: "fixture" });
    await archive.put({ report, attribution: { arena: "foreign.testnet", battleId: 1, community: 0 }, provenance: "fixture" });
    const result = await invoke(s, "battles/1/audits");
    expect(result.body.data.items).toHaveLength(1);
    expect(result.body.data.items[0]).toMatchObject({ provenance: "fixture", freshness: "expired", currentApproval: "notEstablished", attribution: { battleId: "1" } });
  });
  it("extends HTTP without adding account or mutation routes and preserves session authorization", async () => {
    const deps = { ...await makeDeps(), application: service() };
    const request = (url: string, method = "GET") => handleReadRequest({ url, method }, deps);
    expect((await request(`/api/arena/v1/battles?${params()}`)).status).toBe(200);
    expect((await request("/api/arena/v1/actions", "POST")).status).toBe(404);
    expect((await request("/api/arena/v1/accounts/alice.testnet/positions")).status).toBe(404);
    expect((await request("/api/arena/v1/battles", "POST")).status).toBe(405);
    expect((await request("/tools/inspect_positions?accountId=bob.testnet")).status).toBe(403);
    const caps = JSON.parse((await request("/api/arena/v1/capabilities")).body);
    expect(caps.deployments[0].canonicalDiscovery.enabled).toBe(false);
    expect((await invoke(service(deployment({ protocol: "legacy-v1" })), "battles", params(deployment({ protocol: "legacy-v1" })))).status).toBe(422);
  });
  it("caps discovery scans at 200 and pages at 20 by default", async () => {
    const source = new FixtureArenaReadSource("near-testnet", { battles: new Map(Array.from({ length: 210 }, (_, i) => [i + 1, battle()])) });
    const read = vi.spyOn(source, "battle");
    const result = await invoke(service(undefined, { source }));
    expect(result.body.data.items).toHaveLength(20); expect(result.body.data.truncated).toBe(true);
    expect(read).toHaveBeenCalledTimes(200);
  });
  it("reports per-capability dependency failures in health without leaking provider errors", async () => {
    const source = makeSource();
    vi.spyOn(source, "battleCount").mockRejectedValue(new Error("provider credentials"));
    const result = await invoke(service(undefined, { source }), "health");
    expect(result.status).toBe(200);
    expect(result.body.data.components.battles.health).toBe("unavailable");
    expect(result.body.data.components.audits.health).toBe("unavailable");
    expect(result.body.data.canonicalDiscovery.enabled).toBe(false);
    expect(JSON.stringify(result)).not.toContain("provider credentials");
  });
});
