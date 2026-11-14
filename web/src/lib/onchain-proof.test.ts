import { describe, expect, it } from "vitest";
import { classify, formatAmount, loadBattleActivity, symbolOf, type CallInput } from "./onchain-proof";

const base: Omit<CallInput, "method" | "args"> = {
  receiver: "arena.o.testnet",
  symbols: ["WALLET", "CASHCAT", "GOOD", "DEGEN"],
  decimals: () => 18,
  winner: "DEGEN",
  startAtMs: "1794564240000",
};
const call = (method: string, args: Record<string, unknown>, receiver = base.receiver) => classify(46, { ...base, method, args, receiver });

describe("helpers", () => {
  it("derives symbols and formats amounts", () => {
    expect(symbolOf("backing-degen.valtrum-owner-b694.testnet")).toBe("DEGEN");
    expect(formatAmount("12493750000000000000", 18)).toBe("12.49");
    expect(formatAmount("10000000000000000000", 18)).toBe("10");
    expect(formatAmount("5", null)).toBe("5");
  });
});

describe("classify", () => {
  it("recognises the create deposit by its start time", () => {
    const msg = JSON.stringify({ action: "lifecycle_create", mode: "PriceGain", start_at_ms: "1794564240000" });
    expect(call("ft_transfer_call", { amount: "10000000000000000000", msg }, "backing-wallet.o.testnet")).toEqual({
      kind: "create",
      label: "Battle created · 10 WALLET first deposit",
    });
    const other = JSON.stringify({ action: "lifecycle_create", start_at_ms: "1" });
    expect(call("ft_transfer_call", { amount: "1", msg: other }, "backing-wallet.o.testnet")).toBeNull();
  });
  it("keeps deposits and calls for this battle only", () => {
    const msg = JSON.stringify({ action: "lifecycle_deposit", battle_id: 46, community: 1 });
    expect(call("ft_transfer_call", { amount: "2500000000000000000", msg }, "backing-cashcat.o.testnet")?.label).toBe("Deposited 2.5 CASHCAT");
    expect(call("lock_lifecycle_battle", { battle_id: 45 })).toBeNull();
    expect(call("vote_lifecycle_disposition", { battle_id: "46", burn_percent: 50 })?.label).toBe("Winners' vote · burn 50%");
  });
  it("labels joins, settlement and claims", () => {
    expect(call("join_lifecycle_battle", { battle_id: 46, representation: "backing-good.o.testnet" })?.label).toBe("GOOD joined the battle");
    expect(call("settle_lifecycle_battle", { battle_id: "46", max_entitlements: 10 })?.label).toBe("Battle settled · DEGEN wins");
    expect(call("claim_entitlement_as_representation", { amount: "12493750000000000000" }, "backing-good.o.testnet")?.label).toBe("Claimed 12.49 GOOD");
  });
});

describe("loadBattleActivity", () => {
  it("lists this battle's transactions in time order with their hashes", async () => {
    const enc = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
    const rpc = async (method: string, p: unknown) => {
      if (method === "block") return { header: { height: 1000, timestamp: "1794564400000000000" } };
      const { method_name: name } = p as { method_name: string };
      const value =
        name === "get_lifecycle_battle"
          ? { start_at_ms: "1794564240000", communities: [{ representation: "backing-wallet.o.testnet" }, { representation: "backing-degen.o.testnet" }] }
          : name === "get_lifecycle_round"
            ? { winner: 1 }
            : name === "get_lifecycle_disposition"
              ? { closes_at_ns: "1794564349000000000" }
              : { decimals: 18 };
      return { result: enc(value) };
    };
    const b64 = (v: unknown) => btoa(JSON.stringify(v));
    const txs = {
      lock: { signer_id: "agent", receiver_id: "arena.o.testnet", actions: [{ FunctionCall: { method_name: "lock_lifecycle_battle", args: b64({ battle_id: 46 }) } }] },
      other: { signer_id: "agent", receiver_id: "arena.o.testnet", actions: [{ FunctionCall: { method_name: "lock_lifecycle_battle", args: b64({ battle_id: 45 }) } }] },
      settle: { signer_id: "me", receiver_id: "arena.o.testnet", actions: [{ FunctionCall: { method_name: "settle_lifecycle_battle", args: b64({ battle_id: "46" }) } }] },
    } as const;
    const post = async (url: string, body: unknown) => {
      if (url.endsWith("/v0/account")) {
        const { account_id } = body as { account_id: string };
        if (account_id !== "arena.o.testnet") return { account_txs: [] };
        return {
          account_txs: [
            { transaction_hash: "settle", tx_block_height: 900, tx_block_timestamp: "1794564300000000000" },
            { transaction_hash: "other", tx_block_height: 890, tx_block_timestamp: "1794564260000000000" },
            { transaction_hash: "lock", tx_block_height: 880, tx_block_timestamp: "1794564250000000000" },
          ],
        };
      }
      const { tx_hashes } = body as { tx_hashes: (keyof typeof txs)[] };
      return { transactions: tx_hashes.map((h) => ({ transaction: { hash: h, ...txs[h] } })) };
    };
    const a = await loadBattleActivity({ rpc, post, indexer: "https://idx", contract: "arena.o.testnet", battleId: 46, nowMs: 1794564400000 });
    expect(a.winner).toBe("DEGEN");
    expect(a.items.map((i) => [i.hash, i.kind])).toEqual([
      ["lock", "lock"],
      ["settle", "settle"],
    ]);
  });
});
