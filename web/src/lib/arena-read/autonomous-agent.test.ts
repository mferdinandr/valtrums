import { describe, expect, it } from "vitest";
import {
  AGENT_KEY_ENV,
  buildAutonomousConfig,
  fundNearTransaction,
  fundTokenTransaction,
  nearToYocto,
  newAgentKey,
  readAgentStatus,
  runCommand,
  tokensToBase,
} from "./autonomous-agent";

describe("agent key", () => {
  it("makes an ed25519 key whose account is the 64-character hex of its public key", () => {
    const k = newAgentKey();
    expect(k.account).toMatch(/^[0-9a-f]{64}$/);
    expect(k.secretKey.startsWith("ed25519:")).toBe(true);
    expect(k.publicKey.startsWith("ed25519:")).toBe(true);
    expect(newAgentKey().account).not.toBe(k.account);
  });
});

describe("agent config", () => {
  it("holds the env variable name, never a key", () => {
    const text = JSON.stringify(buildAutonomousConfig("a".repeat(64), { strategy: "crowd", sweepTo: "", keepWhole: 0 }));
    expect(text).toContain(AGENT_KEY_ENV);
    expect(text).not.toContain("ed25519");
    expect(text).not.toContain("sweepTo");
  });
  it("adds the owner and the floor together when sweeping", () => {
    const cfg = buildAutonomousConfig("a".repeat(64), { strategy: "underdog", sweepTo: "me.testnet", keepWhole: 50 });
    expect(cfg.agents[0]).toMatchObject({ style: "underdog", sweepTo: "me.testnet", keepWhole: 50 });
    expect(cfg.agents[0]).not.toHaveProperty("mode"); // always NEAR AI
  });
  it("passes the keys by environment variable, not on the command line, and names the NEAR AI key", () => {
    expect(runCommand("my-agent.json")).toContain(`${AGENT_KEY_ENV}=<secret key>`);
    expect(runCommand("my-agent.json")).toContain("NEAR_AI_API_KEY=<near ai key>");
    expect(runCommand("my-agent.json")).toContain("--live");
  });
});

describe("amounts", () => {
  it("parses NEAR exactly and rejects bad input", () => {
    expect(nearToYocto("0.5")).toBe("500000000000000000000000");
    expect(nearToYocto("1")).toBe("1000000000000000000000000");
    expect(nearToYocto("0")).toBeNull();
    expect(nearToYocto("-1")).toBeNull();
    expect(nearToYocto("1e3")).toBeNull();
    expect(nearToYocto("0.1234567890123456789012345")).toBeNull();
  });
  it("converts whole tokens to 18-decimal base units", () => {
    expect(tokensToBase("100")).toBe("100000000000000000000");
    expect(tokensToBase("0")).toBeNull();
    expect(tokensToBase("1.5")).toBeNull();
  });
});

describe("funding transactions", () => {
  it("sends NEAR with one transfer", () => {
    expect(fundNearTransaction("agent", "5")).toEqual({ receiverId: "agent", actions: [{ type: "Transfer", params: { deposit: "5" } }] });
  });
  it("registers the agent on the token and transfers, in one transaction to the token", () => {
    const tx = fundTokenTransaction("backing-wallet.testnet", "agent", "100");
    expect(tx.receiverId).toBe("backing-wallet.testnet");
    const [a, b] = tx.actions;
    expect(a).toMatchObject({ type: "FunctionCall", params: { methodName: "storage_deposit", args: { account_id: "agent", registration_only: true } } });
    expect(b).toMatchObject({ type: "FunctionCall", params: { methodName: "ft_transfer", args: { receiver_id: "agent", amount: "100" }, deposit: "1" } });
  });
});

describe("agent status", () => {
  const rpc = (handlers: Record<string, unknown>, funded = true) => async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { params: { request_type: string; account_id: string; method_name?: string; args_base64?: string } };
    const p = body.params;
    let result: unknown;
    if (p.request_type === "view_account") {
      return Response.json(funded ? { result: { amount: "2000000000000000000000000" } } : { error: { message: "unknown account" } });
    }
    const args = p.args_base64 ? JSON.parse(atob(p.args_base64)) : {};
    const key = `${p.account_id}.${p.method_name}`;
    if (p.method_name === "get_lifecycle_position") result = handlers[`pos:${args.battle_id}:${args.community}`] ?? { registered: false, amount: "0" };
    else result = handlers[key];
    return Response.json({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify(result ?? null))) } });
  };

  it("reads NEAR, token balances and recent plays", async () => {
    const status = await readAgentStatus("https://rpc", "arena", "agent", rpc({
      "arena.get_lifecycle_joinable_assets": [{ chain_id: "46630", token_address: "0x1", representation: "backing-wallet.testnet", custody_domain: "d", reference_chain_id: null, reference_address: null }],
      "backing-wallet.testnet.ft_balance_of": "300",
      "arena.get_lifecycle_battle_count": "2",
      "arena.get_lifecycle_battle": { communities: [{ representation: "backing-wallet.testnet" }] },
      "pos:2:0": { registered: true, amount: "50" },
    }));
    expect(status.nearYocto).toBe("2000000000000000000000000");
    expect(status.tokens).toEqual([{ representation: "backing-wallet.testnet", base: "300" }]);
    expect(status.plays).toEqual([{ battleId: 2, community: 0, representation: "backing-wallet.testnet", amount: "50" }]);
  });

  it("reports an account that does not exist yet as not funded", async () => {
    const status = await readAgentStatus("https://rpc", "arena", "agent", rpc({ "arena.get_lifecycle_joinable_assets": [], "arena.get_lifecycle_battle_count": "0" }, false));
    expect(status.nearYocto).toBeNull();
    expect(status.plays).toEqual([]);
  });
});
