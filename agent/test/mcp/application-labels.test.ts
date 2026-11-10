// Recorded fixtures only. Labels are curated display names, never eligibility.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApplicationReads, handleApplicationRead, type ApplicationBinding } from "../../src/mcp/application.js";
import type { Deployment } from "../../src/mcp/application-contract.js";
import { staticReferenceRegistry } from "../../src/reference-registry.js";
import { FixtureArenaReadSource } from "../../src/mcp/read-source.js";
import { battle, NOW } from "./fixtures.js";

const evidence = JSON.parse(readFileSync(new URL("../../../docs/evidence/2026-11-09-evm-testnet-deploy.json", import.meta.url), "utf8"));
const CASHCAT = evidence.mockTokens.find((t: { symbol: string }) => t.symbol === "mCASHCAT");
const WALLET = evidence.mockTokens.find((t: { symbol: string }) => t.symbol === "mWALLET");

const cap = { enabled: true, reasons: ["recorded test support"] };
const deployment: Deployment = {
  deploymentId: "arena-fixture-v1", network: "near-testnet", arenaContract: "arena.testnet", protocol: "lifecycle-v2", adapter: "fixture",
  companions: { payout: null, registry: "arena.testnet", backing: [] }, abi: { version: "source-abi-v1", evidence: "recorded source inspection", codeHash: null },
  capabilities: { battles: cap, detail: cap, assets: cap, audits: cap },
};
const params = (extra: Record<string, string> = {}) => new URLSearchParams({ deployment: deployment.deploymentId, protocol: deployment.protocol, ...extra });
const make = (binding: ApplicationBinding) => new ApplicationReads([deployment], new Map([[deployment.deploymentId, binding]]), () => NOW);
const get = async (s: ApplicationReads, path: string, extra: Record<string, string> = {}) => {
  const out = await handleApplicationRead("GET", path, params(extra), s);
  return { status: out.status, body: JSON.parse(out.body) };
};

const registry = () =>
  staticReferenceRegistry([
    { chainId: "46630", token: CASHCAT.address.toLowerCase(), referenceChainId: "4663", referenceToken: CASHCAT.referenceMainnetToken.toLowerCase() },
    { chainId: "46630", token: WALLET.address.toLowerCase(), referenceChainId: "4663", referenceToken: WALLET.referenceMainnetToken.toLowerCase() },
    { chainId: "46630", token: "0x" + "c".repeat(40), referenceChainId: "4663", referenceToken: "0x" + "d".repeat(40) },
  ]);

describe("token labels in application reads", () => {
  it("adds a label and reference label to each registry asset and leaves unknown tokens unlabeled", async () => {
    const { body } = await get(make({ registry: registry() }), "assets");
    const bySymbol = Object.fromEntries(body.data.items.map((i: { label: { symbol: string } | null; token: string }) => [i.label?.symbol ?? i.token, i]));
    expect(bySymbol.mCASHCAT.label).toEqual({ symbol: "mCASHCAT", name: "Mock CASHCAT", kind: "testnet-mock" });
    expect(bySymbol.mCASHCAT.referenceLabel).toMatchObject({ symbol: "CASHCAT", kind: "mainnet-reference" });
    const unknown = body.data.items.find((i: { token: string }) => i.token === "0x" + "c".repeat(40));
    expect(unknown.label).toBeNull();
    // A label never changes eligibility.
    for (const i of body.data.items) expect(i.eligibility).toBe("notEstablished");
  });
  it("searches assets by symbol or name on the backend", async () => {
    const s = make({ registry: registry() });
    const bySymbol = await get(s, "assets", { q: "cashcat" });
    expect(bySymbol.body.data.items).toHaveLength(1);
    expect(bySymbol.body.data.items[0].label.symbol).toBe("mCASHCAT");
    expect((await get(s, "assets", { q: "mock wallet" })).body.data.items).toHaveLength(1);
    expect((await get(s, "assets", { q: "wallet" })).body.data.items).toHaveLength(1);
    expect((await get(s, "assets", { q: "pepe" })).body.data.items).toEqual([]);
  });
  it("labels the communities of a listed battle and finds it by token name", async () => {
    const labeled = battle();
    labeled.communities = labeled.communities.map((c, i) => ({ ...c, chain_id: "46630", token_address: i === 0 ? CASHCAT.address : WALLET.address }));
    const source = new FixtureArenaReadSource("near-testnet", { battles: new Map([[1, labeled], [2, battle()]]) });
    const s = make({ source });
    const list = await get(s, "battles");
    expect(list.status).toBe(200);
    const byId = Object.fromEntries(list.body.data.items.map((b: { battleId: string }) => [b.battleId, b]));
    expect(byId["1"].communities[0].label).toMatchObject({ symbol: "mCASHCAT" });
    expect(byId["1"].communities[1].label).toMatchObject({ symbol: "mWALLET" });
    // A battle whose tokens have no curated label still lists, with a null label.
    expect(byId["2"].communities.every((c: { label: unknown }) => c.label === null)).toBe(true);
    // Backend search finds the battle by the token name.
    const found = await get(s, "battles", { q: "cashcat" });
    expect(found.body.data.items.map((b: { battleId: string }) => b.battleId)).toEqual(["1"]);
    // The detail carries labels aligned with the communities.
    const detail = await get(s, "battles/1");
    expect(detail.status).toBe(200);
    expect(detail.body.data.labels.map((l: { symbol: string } | null) => l?.symbol)).toEqual(["mCASHCAT", "mWALLET"]);
  });
});
