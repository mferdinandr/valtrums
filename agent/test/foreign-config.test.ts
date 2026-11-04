import { describe, expect, it } from "vitest";
import { FakeArenaClient } from "../src/fake-client.js";
import { checkExecutionMode } from "../src/runtime.js";
import { loadRuntimeConfig } from "../src/runtime-config.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const QUOTER = "0xC5290058841028F1614F3A6F0F5816cAd0df5E27";
const PEPE = "0x4200000000000000000000000000000000000006";

const good = {
  EXECUTION_MODE: "foreign",
  FOREIGN_RPC_URL: "https://rpc.example.invalid/key-placeholder",
  FOREIGN_CHAIN_ID: "84532",
  FOREIGN_USDC_ADDRESS: USDC,
  FOREIGN_QUOTER_ADDRESS: QUOTER,
  FOREIGN_TOKEN_MAP: JSON.stringify({ "pepe.testnet": PEPE }),
};

describe("foreign runtime config", () => {
  it("parses a complete configuration with defaults", () => {
    const cfg = loadRuntimeConfig(good);
    expect(cfg.executionMode).toBe("foreign");
    expect(cfg.foreign).toMatchObject({
      chainId: 84532n,
      confirmations: 3,
      feeTier: 3000,
      usdc: USDC.toLowerCase(),
      quoter: QUOTER.toLowerCase(),
    });
    expect(cfg.foreign?.tokenMap.get("pepe.testnet")).toBe(PEPE);
  });

  it("is absent in other modes", () => {
    expect(loadRuntimeConfig({}).foreign).toBeUndefined();
    expect(loadRuntimeConfig({ ...good, EXECUTION_MODE: "mock" }).foreign).toBeUndefined();
  });

  it.each([
    ["FOREIGN_RPC_URL", undefined, /FOREIGN_RPC_URL is required/],
    ["FOREIGN_RPC_URL", "not a url", /valid URL/],
    ["FOREIGN_RPC_URL", "http://rpc.example.invalid", /https/],
    ["FOREIGN_CHAIN_ID", undefined, /FOREIGN_CHAIN_ID is required/],
    ["FOREIGN_CHAIN_ID", "0", /positive integer/],
    ["FOREIGN_CHAIN_ID", "base", /positive integer/],
    ["FOREIGN_CONFIRMATIONS", "0", /FOREIGN_CONFIRMATIONS/],
    ["FOREIGN_FEE_TIER", "123", /FOREIGN_FEE_TIER/],
    ["FOREIGN_USDC_ADDRESS", undefined, /FOREIGN_USDC_ADDRESS is required/],
    ["FOREIGN_USDC_ADDRESS", "0x12", /20-byte/],
    ["FOREIGN_QUOTER_ADDRESS", "zz", /20-byte/],
    ["FOREIGN_TOKEN_MAP", undefined, /FOREIGN_TOKEN_MAP is required/],
    ["FOREIGN_TOKEN_MAP", "{", /valid JSON/],
    ["FOREIGN_TOKEN_MAP", "[]", /JSON object/],
    ["FOREIGN_TOKEN_MAP", "{}", /at least one/],
    ["FOREIGN_TOKEN_MAP", JSON.stringify({ a: "0x12" }), /"a" must map/],
    ["FOREIGN_TOKEN_MAP", JSON.stringify({ a: USDC }), /USDC address/],
    ["FOREIGN_TOKEN_MAP", JSON.stringify({ a: PEPE, b: PEPE }), /two tokens/],
  ])("rejects %s = %s", (name, value, message) => {
    const env: Record<string, string | undefined> = { ...good, [name]: value };
    expect(() => loadRuntimeConfig(env)).toThrow(message);
  });

  it("accepts http only for localhost and never echoes the url", () => {
    expect(loadRuntimeConfig({ ...good, FOREIGN_RPC_URL: "http://127.0.0.1:8545" }).foreign).toBeDefined();
    try {
      loadRuntimeConfig({ ...good, FOREIGN_RPC_URL: "http://rpc.example.invalid/key-placeholder" });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("key-placeholder");
    }
  });
});

describe("foreign execution mode check", () => {
  const foreign = {
    mpc_contract: "signer.testnet",
    chain_id: "84532",
    router: "11".repeat(20),
    treasury: "22".repeat(20),
    burn: "33".repeat(20),
  };

  it("needs no execution dex and a foreign signing configuration", async () => {
    const c = new FakeArenaClient();
    expect(await checkExecutionMode(c, "foreign")).toMatch(/no foreign signing configuration/);
    c.foreign = foreign;
    expect(await checkExecutionMode(c, "foreign")).toBeNull();
    c.setExecution("dex.testnet", "burn.testnet");
    expect(await checkExecutionMode(c, "foreign")).toMatch(/executes on-chain via dex.testnet/);
  });
});
