// FIXTURE-ONLY: a fake RPC. Nothing here touches a chain.
import { describe, expect, it } from "vitest";
import { readBalances, readNearBalance } from "./balances";

const E18 = 10n ** 18n;
const enc = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));

const rpc = (answers: Record<string, unknown>, account: { amount?: string; missing?: boolean } = { amount: "5000000000000000000000000" }) =>
  async (_u: string, init: RequestInit) => {
    const p = JSON.parse(String(init.body)).params as { request_type: string; account_id: string; method_name?: string };
    if (p.request_type === "view_account") {
      return new Response(JSON.stringify(account.missing ? { error: { message: "account does not exist" } } : { result: { amount: account.amount } }), { status: 200 });
    }
    const key = `${p.account_id}.${p.method_name}`;
    if (!(key in answers)) return new Response(JSON.stringify({ result: { error: `no answer for ${key}` } }), { status: 200 });
    return new Response(JSON.stringify({ result: { result: enc(answers[key]) } }), { status: 200 });
  };

const answers = {
  "faucet.testnet.get_tokens": [
    { token: "backing-cashcat.testnet", symbol: "CASHCAT" },
    { token: "backing-wallet.testnet", symbol: "WALLET" },
  ],
  "backing-cashcat.testnet.ft_balance_of": (100n * E18).toString(),
  "backing-wallet.testnet.ft_balance_of": null,
};

describe("readBalances", () => {
  it("returns the NEAR balance and one entry per faucet token", async () => {
    const b = await readBalances("https://rpc", "faucet.testnet", "alice.testnet", rpc(answers));
    expect(b.near).toBe("5000000000000000000000000");
    expect(b.tokens.map((t) => [t.symbol, t.balance])).toEqual([["CASHCAT", (100n * E18).toString()], ["WALLET", "0"]]);
  });
  it("treats an account that does not exist as holding zero NEAR", async () => {
    expect(await readNearBalance("https://rpc", "ghost.testnet", rpc(answers, { missing: true }))).toBe("0");
  });
  it("fails when the faucet contract does not answer", async () => {
    await expect(readBalances("https://rpc", "faucet.testnet", "alice.testnet", rpc({}))).rejects.toThrow();
  });
});
