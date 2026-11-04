import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { NearArenaClient, type NearTransport } from "../src/near-client.js";

function stubTransport() {
  const calls: { kind: string; contract: string; method: string; args: object }[] = [];
  const transport: NearTransport = {
    async view<T>(contract: string, method: string, args: object) {
      calls.push({ kind: "view", contract, method, args });
      return (method === "get_battle_count" ? "3" : null) as T;
    },
    async call(contract, method, args) {
      calls.push({ kind: "call", contract, method, args });
      return {};
    },
  };
  return { transport, calls };
}

describe("NearArenaClient", () => {
  it("encodes u128 prices as strings", async () => {
    const { transport, calls } = stubTransport();
    const client = new NearArenaClient("arena.testnet", transport);
    await client.setInitialPrices(7, 10n ** 30n, 5n);
    expect(calls[0]).toMatchObject({
      kind: "call",
      contract: "arena.testnet",
      method: "set_initial_prices",
      args: { battle_id: 7, price_a: "1" + "0".repeat(30), price_b: "5" },
    });
  });

  it("passes the void reason through", async () => {
    const { transport, calls } = stubTransport();
    await new NearArenaClient("arena.testnet", transport).voidBattle(1, "low liquidity");
    expect(calls[0]?.args).toEqual({ battle_id: 1, reason: "low liquidity" });
  });

  it("returns null for a missing battle and parses the count", async () => {
    const { transport } = stubTransport();
    const client = new NearArenaClient("arena.testnet", transport);
    expect(await client.getBattle(9)).toBeNull();
    expect(await client.getBattleCount()).toBe(3);
  });
});

describe("loadConfig", () => {
  const base = {
    ARENA_CONTRACT_ID: "arena.testnet",
    AGENT_ACCOUNT_ID: "agent.testnet",
    AGENT_PRIVATE_KEY: "ed25519:abc",
  };
  it("applies testnet defaults", () => {
    const cfg = loadConfig(base);
    expect(cfg.rpcUrl).toBe("https://rpc.testnet.near.org");
    expect(cfg.dexscreenerApiKey).toBeUndefined();
  });
  it("fails on missing vars without leaking the key", () => {
    expect(() => loadConfig({ ...base, ARENA_CONTRACT_ID: "" })).toThrow(/ARENA_CONTRACT_ID/);
    try {
      loadConfig({ ...base, AGENT_PRIVATE_KEY: "secret-value" });
    } catch (e) {
      expect(String(e)).not.toContain("secret-value");
    }
  });
});
