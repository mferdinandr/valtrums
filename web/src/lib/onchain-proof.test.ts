import { describe, expect, it } from "vitest";
import { formatAmount, loadBattleProof, symbolOf, verifyCommand } from "./onchain-proof";

const enc = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));

describe("presentation helpers", () => {
  it("derives the token symbol from the backing account", () => {
    expect(symbolOf("backing-degen.valtrum-owner-b694.testnet")).toBe("DEGEN");
    expect(symbolOf("usdc.testnet")).toBe("USDC");
  });
  it("formats with decimals and keeps raw units without them", () => {
    expect(formatAmount("12500000000000000000", 18)).toBe("12.5");
    expect(formatAmount("10000000000000000000", 18)).toBe("10");
    expect(formatAmount("12500000000000000000", null)).toBe("12500000000000000000");
  });
  it("builds a near-cli-rs read command", () => {
    expect(verifyCommand("arena.x.testnet", 46, "testnet")).toContain("get_lifecycle_round json-args '{\"battle_id\":\"46\"}' network-config testnet");
  });
});

describe("loadBattleProof", () => {
  it("reads battle, round, DAO and token decimals with the block of the read", async () => {
    const calls: string[] = [];
    const rpc = async (_m: string, p: unknown) => {
      const { method_name: name, account_id: account } = p as { method_name: string; account_id: string };
      calls.push(`${account}:${name}`);
      const value =
        name === "get_lifecycle_battle"
          ? { creator: "c.testnet", mode: "PriceGain", locked: true, cancelled: false, communities: [{ representation: "backing-wallet.o.testnet", vault: "10000000000000000000" }, { representation: "backing-degen.o.testnet", vault: "5000000000000000000" }] }
          : name === "get_lifecycle_round"
            ? { round_id: "1", winner: 1 }
            : name === "get_lifecycle_disposition"
              ? { status: "decided", burn_weight: "1", return_weight: "1", burn_total: "2", return_total: "3", released: 2, total_releases: 2 }
              : { decimals: 18 };
      return { result: enc(value), block_height: 277682640, block_hash: "4dZf" };
    };
    const proof = await loadBattleProof(rpc, "arena.o.testnet", 46);
    expect(proof.winner).toBe(1);
    expect(proof.communities.map((c) => c.symbol)).toEqual(["WALLET", "DEGEN"]);
    expect(proof.communities[0]?.decimals).toBe(18);
    expect(proof.dao).toEqual({ status: "decided", burn: "2", return: "3", released: 2, total: 2 });
    expect(proof.blockHeight).toBe(277682640);
    expect(calls).toContain("backing-degen.o.testnet:ft_metadata");
  });
  it("fails clearly when the battle does not exist", async () => {
    const rpc = async () => ({ result: enc(null), block_height: 1, block_hash: "h" });
    await expect(loadBattleProof(rpc, "a.testnet", 999)).rejects.toThrow("#999");
  });
});
