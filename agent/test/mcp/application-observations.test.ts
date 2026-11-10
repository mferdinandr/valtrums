// FIXTURE-ONLY: a temp-directory journal and a stubbed ABI view. No provider, deployed contract or live feed.
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VersionedLifecycleReadSource } from "../../src/mcp/application-adapter.js";
import { ApplicationReads, handleApplicationRead, type ApplicationBinding } from "../../src/mcp/application.js";
import { namespaceOf, type Deployment } from "../../src/mcp/application-contract.js";
import { ObservationJournal, loadObservationState } from "../../src/observations/journal.js";
import { battle } from "./fixtures.js";
import { END_MS, END_NS, POLICY, START_MS, START_NS, price } from "../observations/fixtures.js";

const cap = { enabled: true, reasons: ["recorded test support"] };
const deployment = (): Deployment => ({
  deploymentId: "testnet-a", network: "near-testnet", arenaContract: "arena.testnet", protocol: "lifecycle-v2", adapter: "fixture",
  companions: { payout: null, registry: null, backing: [] }, abi: { version: "lifecycle-application-v1", evidence: "recorded test", codeHash: null },
  capabilities: { battles: cap, detail: cap, assets: cap, audits: cap, observations: cap },
});

let dir: string;
let j: ObservationJournal;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "app-obs-")); j = await ObservationJournal.open(dir); });
afterEach(async () => { await j.close(); await rm(dir, { recursive: true, force: true }); });

const view = (round: { winner: number | null; start: string | null; end: string | null } = { winner: null, start: START_NS, end: END_NS }) =>
  async (_c: string, method: string) => {
    if (method === "get_lifecycle_battle_v1") return battle({ locked: true, mode: "PriceGain", observation_policy_hash: POLICY });
    if (method === "get_lifecycle_round") return { round_id: "1", candidates: [0, 1], start_ns: round.start, end_ns: round.end, winner: round.winner };
    throw new Error("unknown view");
  };

function service(over: Partial<NonNullable<ApplicationBinding["observations"]>> = {}, v = view()) {
  const d = deployment();
  const binding: ApplicationBinding = {
    versioned: new VersionedLifecycleReadSource("arena.testnet", v),
    observations: {
      namespace: namespaceOf(d), load: async () => (await loadObservationState(dir)).state,
      qualifiedModes: new Set(["PriceGain"] as const), coveragePolicy: { boundaryToleranceMs: 1_000, maxGapMs: 40_000 }, ...over,
    },
  };
  return new ApplicationReads([d], new Map([[d.deploymentId, binding]]), () => 1_800_000_000_000);
}
const get = async (s: ApplicationReads, extra: Record<string, string> = {}, path = "battles/1/observations") => {
  const out = await handleApplicationRead("GET", path, new URLSearchParams({ deployment: "testnet-a", protocol: "lifecycle-v2", ...extra }), s);
  return { status: out.status, body: JSON.parse(out.body) };
};

describe("GET battles/{id}/observations", () => {
  it("serves persisted samples with exact provisional scores, separate recorded outcome and honest labels", async () => {
    for (const [c, a, b] of [[0, "300", "310"], [1, "200", "190"]] as const) { await j.append(price(c, START_MS, a)); await j.append(price(c, END_MS, b)); }
    const { status, body } = await get(service());
    expect(status).toBe(200);
    expect(body.data.items).toHaveLength(4);
    expect(body.data.items[0].seq).toBe("1");
    expect(body.data.sourceKind).toBe("fixture");
    expect(body.provenance).toMatchObject({ kind: "market", health: "degraded", complete: true });
    expect(body.provenance.reasons.join(" ")).toMatch(/fixture samples: not live provider evidence/);
    expect(body.data.projection).toMatchObject({ status: "provisional", authoritative: false, provisionalLeaders: [0] });
    expect(body.data.projection.scores[1]).toEqual({ community: 1, negative: true, numerator: "10", denominator: "200" });
    expect(body.data.recorded).toMatchObject({ roundId: "1", winner: null }); // the contract outcome is its own field
  });

  it("derives the source label from the samples, so configuration cannot relabel a fixture as live", async () => {
    await j.append(price(0, START_MS, "100"));
    await j.append(price(1, START_MS, "100", { source: { name: "other", kind: "live", pool: null, quote: "USD" } }));
    const mixed = await get(service());
    expect(mixed.body.data.sourceKind).toBe("fixture"); // the least trusted kind present wins
    expect(mixed.body.data.sourceKinds).toEqual(["fixture", "live"]);
    expect(mixed.body.provenance.reasons.join(" ")).toMatch(/mixed sample sources/);
    expect(mixed.body.provenance.health).toBe("degraded");
    const empty = await get(service(), { community: "5" });
    expect(empty.body.data.sourceKind).toBe("none");
  });

  it("never lets a provisional leader override the recorded winner", async () => {
    await j.append(price(0, START_MS, "100")); await j.append(price(0, END_MS, "200"));
    await j.append(price(1, START_MS, "100")); await j.append(price(1, END_MS, "50"));
    const { body } = await get(service({}, view({ winner: 1, start: START_NS, end: END_NS })));
    expect(body.data.projection.provisionalLeaders).toEqual([0]);
    expect(body.data.recorded.winner).toBe(1);
  });

  it("withholds coverage and scores when frozen facts, the window, or an approved policy are missing", async () => {
    await j.append(price(0, START_MS, "100"));
    const noWindow = await get(service({}, view({ winner: null, start: null, end: null })));
    expect(noWindow.body.data.projection).toBeNull();
    expect(noWindow.body.provenance.reasons.join(" ")).toMatch(/round window not recorded yet/);
    const noPolicy = await get(service({ coveragePolicy: null }));
    expect(noPolicy.body.data.projection).toBeNull();
    expect(noPolicy.body.provenance.reasons.join(" ")).toMatch(/no approved coverage policy/);
    expect(noPolicy.body.data.items).toHaveLength(1); // the evidence itself is still served
  });

  it("keeps an unqualified mode unavailable and a missing close incomplete", async () => {
    await j.append(price(0, START_MS, "100")); await j.append(price(1, START_MS, "100")); await j.append(price(1, END_MS, "120"));
    const unq = await get(service({ qualifiedModes: new Set() }));
    expect(unq.body.data.projection.status).toBe("unavailable");
    const inc = await get(service());
    expect(inc.body.data.projection).toMatchObject({ status: "incomplete", provisionalLeaders: [] });
    expect(inc.body.provenance.complete).toBe(false);
  });

  it("bounds pages, validates parameters and does not accept a foreign namespace's evidence", async () => {
    for (let i = 0; i < 3; i++) await j.append(price(0, START_MS + BigInt(i) * 1000n, String(100 + i)));
    await j.append(price(0, START_MS, "7", { namespace: { deploymentId: "other", network: "near-testnet", arenaContract: "arena.testnet", protocol: "lifecycle-v2" } }));
    const s = service();
    const first = await get(s, { limit: "2" });
    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.truncated).toBe(true);
    const next = await get(s, { limit: "2", after: first.body.data.nextCursor });
    expect(next.body.data.items).toHaveLength(1);
    const bad: Record<string, string>[] = [{ limit: "51" }, { community: "16" }, { round: "x" }, { after: "-1" }, { evil: "1" }];
    for (const extra of bad) expect((await get(s, extra)).status).toBe(400);
    expect((await get(s, {}, "battles/18446744073709551616/observations")).status).toBe(400);
  });

  it("reports a retraction through the revision and drops the evidence from the page", async () => {
    const a = await j.append(price(0, START_MS, "100"));
    const s = service();
    const before = await get(s);
    await j.retract({ namespace: namespaceOf(deployment()), observationId: a.id, reason: "source block retracted", acquiredAtMs: "1" });
    const after = await get(s, { after: before.body.provenance.watermark });
    expect(after.body.data.revision).toBe("1");
    expect(after.body.data.retractedSinceCursor).toEqual([a.id]);
    expect((await get(s)).body.data.items).toHaveLength(0);
    expect(after.body.provenance.readModelVersion).not.toBe(before.body.provenance.readModelVersion);
  });

  it("answers 503 for a corrupt or missing journal instead of an empty chart or a fixture fallback", async () => {
    await j.append(price(0, START_MS, "100"));
    await j.close();
    const path = join(dir, "journal.jsonl");
    await writeFile(path, (await readFile(path, "utf8")).replace('"price":"100"', '"price":"101"'));
    const bad = await get(service());
    expect(bad.status).toBe(503);
    expect(bad.body.error.code).toBe("observations_unavailable");
    const missing = await get(service({ load: async () => { throw new Error("ENOENT"); } }));
    expect(missing.status).toBe(503);
  });

  it("is unsupported when the capability is not declared, not bound, or the deployment is legacy", async () => {
    const d = deployment();
    const undeclared = { ...d, capabilities: { battles: cap, detail: cap, assets: cap, audits: cap } };
    const s1 = new ApplicationReads([undeclared], new Map([[d.deploymentId, {}]]), () => 1);
    expect((await get(s1)).status).toBe(422);
    const caps = await handleApplicationRead("GET", "capabilities", new URLSearchParams(), s1);
    expect(JSON.parse(caps.body).deployments[0].capabilities.observations.enabled).toBe(false);
    const s2 = new ApplicationReads([d], new Map([[d.deploymentId, { versioned: new VersionedLifecycleReadSource("arena.testnet", view()) }]]), () => 1);
    const unbound = await get(s2);
    expect(unbound.status).toBe(422);
    expect(unbound.body.error.message).toMatch(/observation journal handoff unavailable/);
  });

  it("rejects an observation binding for another namespace at construction", () => {
    const d = deployment();
    expect(() => new ApplicationReads([d], new Map([[d.deploymentId, { observations: {
      namespace: { ...namespaceOf(d), deploymentId: "other" }, load: async () => (await loadObservationState(dir)).state,
      qualifiedModes: new Set(), coveragePolicy: null } }]]), () => 1)).toThrow(/foreign observation journal binding/);
  });
});
