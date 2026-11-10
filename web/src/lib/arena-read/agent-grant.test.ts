// FIXTURE-ONLY: synthetic accounts and responses. Nothing here touches a chain.
import { describe, expect, it } from "vitest";
import {
  addSavedGrant, buildGrantReview, buildRevokeReview, emptyGrantForm, fromHex, parseSavedGrants, randomLocalId, readGrantStatus, rpcView, toHex, type GrantForm,
} from "./agent-grant";

const NOW = Date.parse("2026-11-11T00:00:00Z");
const localId = Array.from({ length: 32 }, (_, i) => i + 1);
const ctx = { policy: "policy.testnet", arena: "arena.testnet", user: "alice.testnet", nowMs: NOW, localId };
const form = (over: Partial<GrantForm> = {}): GrantForm => ({
  ...emptyGrantForm(), delegate: "agent.testnet", chainId: "46630", token: "0x5b2BA17e5be1B611c1299809Db89c5Fe21D9D0a6",
  representation: "cashcat.rep.testnet", custodyDomain: "custody-v1", perAction: "100", cumulative: "500", ...over,
});

describe("create_grant review", () => {
  it("builds the exact wire input the contract expects", () => {
    const r = buildGrantReview(form(), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receiver).toBe("policy.testnet");
    expect(r.method).toBe("create_grant");
    expect(r.args).toEqual({
      input: {
        delegate: "agent.testnet", local_id: localId, version: "1",
        asset: { chain_id: "46630", token: "0x5b2ba17e5be1b611c1299809db89c5fe21d9d0a6", representation: "cashcat.rep.testnet", custody_domain: "custody-v1", mapping_version: "1" },
        contracts: ["cashcat.rep.testnet"], methods: ["ft_transfer_call"], destinations: ["arena.testnet"], battle: null,
        per_action_cap: "100", cumulative_cap: "500", gas_cap: "100000000000000",
        expiry_ns: String(BigInt(NOW + 7 * 86_400_000) * 1_000_000n),
      },
    });
    expect(r.localIdHex).toBe(toHex(localId));
    expect(r.notes.join(" ")).toMatch(/not enabled yet/);
  });
  it("can scope the grant to one battle", () => {
    const r = buildGrantReview(form({ battleId: "7" }), ctx);
    expect(r.ok && (r.args as { input: { battle: unknown } }).input.battle).toEqual({ battle_id: "7", community: null });
  });
  it("refuses the user as their own agent, bad limits and bad lifetimes", () => {
    const bad = (over: Partial<GrantForm>) => {
      const r = buildGrantReview(form(over), ctx);
      return r.ok ? [] : r.problems;
    };
    expect(bad({ delegate: "alice.testnet" }).join(" ")).toMatch(/must differ/);
    expect(bad({ delegate: "" }).join(" ")).toMatch(/agent account/);
    expect(bad({ perAction: "600" }).join(" ")).toMatch(/cannot exceed/);
    expect(bad({ perAction: "0" }).join(" ")).toMatch(/per-action/);
    expect(bad({ cumulative: "1.5" }).join(" ")).toMatch(/total budget/);
    expect(bad({ days: "0" }).join(" ")).toMatch(/lifetime/);
    expect(bad({ days: "91" }).join(" ")).toMatch(/lifetime/);
    expect(bad({ gasCapTgas: "301" }).join(" ")).toMatch(/gas/);
    expect(bad({ token: "0x12" }).join(" ")).toMatch(/registry/);
    expect(bad({ battleId: "0" }).join(" ")).toMatch(/battle id/);
    expect(bad({ custodyDomain: " " }).join(" ")).toMatch(/custody domain/);
  });
  it("needs a connected wallet and configured contracts", () => {
    const r = buildGrantReview(form(), { ...ctx, user: null, policy: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.join(" ")).toMatch(/connect your wallet/);
      expect(r.problems.join(" ")).toMatch(/player-policy/);
    }
  });
  it("accepts large base-unit amounts exactly", () => {
    const big = "340282366920938463463374607431768211455";
    const r = buildGrantReview(form({ perAction: big, cumulative: big }), ctx);
    expect(r.ok && (r.args as { input: { cumulative_cap: string } }).input.cumulative_cap).toBe(big);
  });
});

describe("revoke review", () => {
  it("attaches one yocto and sends the id as bytes", () => {
    const r = buildRevokeReview("policy.testnet", toHex(localId));
    expect(r.ok && r.depositYocto).toBe("1");
    expect(r.ok && r.args).toEqual({ local_id: localId });
    expect(buildRevokeReview("policy.testnet", "zz").ok).toBe(false);
  });
});

describe("grant ids", () => {
  it("round-trips hex and rejects malformed ids", () => {
    expect(fromHex(toHex(localId))).toEqual(localId);
    expect(fromHex("abc")).toBeNull();
    expect(randomLocalId((n) => new Uint8Array(n).fill(7))).toEqual(Array(32).fill(7));
  });
});

const rpc = (payload: Record<string, unknown>) => async (_u: string, init: RequestInit) => {
  const method = JSON.parse(String(init.body)).params.method_name as string;
  const value = payload[method];
  return new Response(JSON.stringify({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } }), { status: 200 });
};

describe("reading a grant", () => {
  const grant = { delegate: "agent.testnet", revoked: false, per_action_cap: "100", cumulative_cap: "500", gas_cap: "100000000000000", expiry_ns: String(BigInt(NOW + 3_600_000) * 1_000_000n) };
  const budget = { authorized_limit: "500", consumed: "0", reserved: "100", available: "400" };
  it("reports an active grant with its budget", async () => {
    const s = await readGrantStatus("https://rpc", "policy.testnet", "alice.testnet", toHex(localId), NOW, rpc({ get_grant: grant, get_budget: budget }));
    expect(s).toMatchObject({ state: "active", delegate: "agent.testnet", gasCapTgas: "100", budget: { available: "400", reserved: "100" } });
  });
  it("distinguishes revoked, expired and missing", async () => {
    const at = (over: Record<string, unknown>, now = NOW) => readGrantStatus("https://rpc", "policy.testnet", "alice.testnet", toHex(localId), now, rpc({ get_grant: { ...grant, ...over }, get_budget: budget }));
    expect((await at({ revoked: true })).state).toBe("revoked");
    expect((await at({}, NOW + 7_200_000)).state).toBe("expired");
    const missing = await readGrantStatus("https://rpc", "policy.testnet", "alice.testnet", toHex(localId), NOW, rpc({ get_grant: null, get_budget: null }));
    expect(missing.state).toBe("missing");
    expect(missing.budget).toBeNull();
  });
  it("fails on an RPC error instead of reporting an empty grant", async () => {
    await expect(rpcView("https://rpc", "policy.testnet", "get_grant", {}, async () => new Response("{}", { status: 503 }))).rejects.toThrow(/503/);
    await expect(rpcView("https://rpc", "policy.testnet", "get_grant", {}, async () => new Response(JSON.stringify({ result: { error: "no such method" } }), { status: 200 }))).rejects.toThrow(/no such method/);
  });
});

describe("saved grant ids", () => {
  it("parses only well-formed entries and never throws", () => {
    expect(parseSavedGrants(null)).toEqual([]);
    expect(parseSavedGrants("not json")).toEqual([]);
    expect(parseSavedGrants("{}")).toEqual([]);
    const good = { localIdHex: toHex(localId), createdAtMs: NOW, label: "CASHCAT" };
    expect(parseSavedGrants(JSON.stringify([good, { localIdHex: "zz", createdAtMs: 1, label: "x" }, 5]))).toEqual([good]);
  });
  it("adds a grant once and keeps the newest first", () => {
    const a = { localIdHex: toHex(localId), createdAtMs: 1, label: "A" };
    const b = { localIdHex: toHex(localId.map((x) => x + 1)), createdAtMs: 2, label: "B" };
    expect(addSavedGrant(addSavedGrant([], a), b).map((g) => g.label)).toEqual(["B", "A"]);
    expect(addSavedGrant([a], a)).toHaveLength(1);
  });
});
