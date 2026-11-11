import { describe, expect, it } from "vitest";
import { ApplicationReads, handleApplicationRead, type ApplicationBinding } from "../../src/mcp/application.js";
import type { Deployment } from "../../src/mcp/application-contract.js";
import { battleSchema } from "../../src/mcp/application-adapter.js";
import { FixtureArenaReadSource, isFunded } from "../../src/mcp/read-source.js";
import { parseSearchParams, searchBattles } from "../../src/mcp/search.js";
import { battle, NOW } from "./fixtures.js";

const cap = { enabled: true, reasons: ["recorded test support"] };
const deployment: Deployment = {
  deploymentId: "arena-fixture-v1", network: "near-testnet", arenaContract: "arena.testnet", protocol: "lifecycle-v2", adapter: "fixture",
  companions: { payout: null, registry: "arena.testnet", backing: [] }, abi: { version: "source-abi-v1", evidence: "recorded source inspection", codeHash: null },
  capabilities: { battles: cap, detail: cap, assets: cap, audits: cap },
};
const params = (extra: Record<string, string> = {}) => new URLSearchParams({ deployment: deployment.deploymentId, protocol: deployment.protocol, ...extra });
const make = (binding: ApplicationBinding) => new ApplicationReads([deployment], new Map([[deployment.deploymentId, binding]]), () => NOW);
const get = async (s: ApplicationReads, path: string) => {
  const out = await handleApplicationRead("GET", path, params(), s);
  return { status: out.status, body: JSON.parse(out.body) };
};

const open = battle({ communities: [], start_at_ms: String(NOW + 3_600_000), cancelled: false });
const mixed = battle({ start_at_ms: String(NOW + 60_000), cancelled: false });
mixed.communities[0] = { ...mixed.communities[0]!, vault: "500" };
const cancelled = battle({ start_at_ms: String(NOW - 1000), cancelled: true });

describe("open arena read model", () => {
  it("parses a battle with zero communities and the new fields, and still parses the old shape", () => {
    expect(battleSchema.safeParse(open).success).toBe(true);
    expect(battleSchema.parse(open).start_at_ms).toBe(String(NOW + 3_600_000));
    const { start_at_ms: _s, cancelled: _c, ...old } = mixed;
    expect(battleSchema.safeParse(old).success).toBe(true);
    expect(battleSchema.safeParse({ ...mixed, cancelled: "yes" }).success).toBe(false);
    expect(battleSchema.safeParse({ ...mixed, start_at_ms: "1.5" }).success).toBe(false);
  });
  it("rejects more than 16 communities", () => {
    const c = mixed.communities[0]!;
    expect(battleSchema.safeParse({ ...mixed, communities: Array.from({ length: 17 }, () => c) }).success).toBe(false);
    expect(battleSchema.safeParse({ ...mixed, communities: Array.from({ length: 16 }, () => c) }).success).toBe(true);
  });
  it("lists entered and pending communities, start time and the cancelled status", async () => {
    const source = new FixtureArenaReadSource("near-testnet", { battles: new Map([[1, open], [2, mixed], [3, cancelled]]) });
    const { status, body } = await get(make({ source }), "battles");
    expect(status).toBe(200);
    const byId = Object.fromEntries(body.data.items.map((i: { battleId: string }) => [i.battleId, i]));
    expect(byId["1"]).toMatchObject({ status: "open", enteredCount: 0, pendingCount: 0, cancelled: false, communities: [] });
    expect(byId["2"]).toMatchObject({ enteredCount: 1, pendingCount: 1, startAtMs: String(NOW + 60_000) });
    expect(byId["2"].communities.map((c: { funded: boolean }) => c.funded)).toEqual([true, false]);
    expect(byId["3"]).toMatchObject({ status: "cancelled", cancelled: true });
  });
  it("search exposes the same fields and filters by cancelled", async () => {
    const source = new FixtureArenaReadSource("near-testnet", { battles: new Map([[1, open], [2, mixed], [3, cancelled]]) });
    const page = await searchBattles(source, parseSearchParams({ status: "cancelled" }));
    expect(page.items.map((b) => b.battleId)).toEqual([3]);
    const all = await searchBattles(source, parseSearchParams({}));
    expect(all.items.find((b) => b.battleId === 2)).toMatchObject({ enteredCount: 1, pendingCount: 1 });
  });
  it("treats only a positive vault as funded", () => {
    expect(isFunded({ vault: "0" })).toBe(false);
    expect(isFunded({ vault: "1" })).toBe(true);
  });
});
