// FIXTURE-ONLY: a fake RPC. Nothing here touches a chain.
import { describe, expect, it } from "vitest";
import { buildClaimCall, formatWait, readFaucet, unavailableReason, type FaucetEntry } from "./faucet";

const NOW = 1_800_000_000_000;
const E18 = 10n ** 18n;
const rpc = (answers: Record<string, unknown>) => async (_u: string, init: RequestInit) => {
  const p = JSON.parse(String(init.body)).params as { account_id: string; method_name: string; args_base64: string };
  const args = JSON.parse(atob(p.args_base64)) as Record<string, string>;
  const key = `${p.account_id}.${p.method_name}${args.token ? `.${args.token}` : ""}`;
  if (!(key in answers)) return new Response(JSON.stringify({ result: { error: `no answer for ${key}` } }), { status: 200 });
  return new Response(JSON.stringify({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify(answers[key]))) } }), { status: 200 });
};
const tokens = [
  { token: "backing-cashcat.testnet", symbol: "CASHCAT", amount: (100n * E18).toString(), daily_budget: "0", budget_left: null },
  { token: "backing-wallet.testnet", symbol: "WALLET", amount: (100n * E18).toString(), daily_budget: (300n * E18).toString(), budget_left: (50n * E18).toString() },
];
const answers = (over: Record<string, unknown> = {}) => ({
  "faucet.testnet.get_config": { paused: false, cooldown_secs: "86400" },
  "faucet.testnet.get_tokens": tokens,
  "backing-cashcat.testnet.ft_balance_of": (1_000_000n * E18).toString(),
  "backing-wallet.testnet.ft_balance_of": (1_000_000n * E18).toString(),
  "faucet.testnet.get_claim_status.backing-cashcat.testnet": { last_claim_ns: null, next_claim_ns: "0", can_claim: true },
  "faucet.testnet.get_claim_status.backing-wallet.testnet": { last_claim_ns: null, next_claim_ns: "0", can_claim: true },
  ...over,
});

describe("readFaucet", () => {
  it("lists every token with its stock and whether this account can claim", async () => {
    const s = await readFaucet("https://rpc", "faucet.testnet", "alice.testnet", NOW, rpc(answers()));
    expect(s.tokens.map((t) => t.symbol)).toEqual(["CASHCAT", "WALLET"]);
    expect(s.tokens[0]).toMatchObject({ inStock: true, canClaim: true, cooldownRemainingMs: 0 });
    // The daily budget left (50) is below one claim (100): not claimable even though stock exists.
    expect(s.tokens[1]).toMatchObject({ inStock: true, canClaim: false });
    expect(unavailableReason(s.tokens[1]!, false)).toMatch(/budget/);
  });
  it("shows the stock without an account (signed out)", async () => {
    const s = await readFaucet("https://rpc", "faucet.testnet", null, NOW, rpc(answers()));
    expect(s.tokens[0]!.stock).toBe((1_000_000n * E18).toString());
    expect(s.tokens[0]!.cooldownRemainingMs).toBe(0);
  });
  it("reports the cooldown remaining from the contract's next-claim time", async () => {
    const next = BigInt(NOW + 3_600_000) * 1_000_000n;
    const s = await readFaucet("https://rpc", "faucet.testnet", "alice.testnet", NOW, rpc(answers({
      "faucet.testnet.get_claim_status.backing-cashcat.testnet": { last_claim_ns: "1", next_claim_ns: next.toString(), can_claim: false },
    })));
    expect(s.tokens[0]).toMatchObject({ cooldownRemainingMs: 3_600_000, canClaim: false });
    expect(unavailableReason(s.tokens[0]!, false)).toMatch(/1 h 0 min/);
  });
  it("marks a token with too little stock and a paused faucet as unavailable", async () => {
    const s = await readFaucet("https://rpc", "faucet.testnet", "alice.testnet", NOW, rpc(answers({
      "backing-cashcat.testnet.ft_balance_of": (99n * E18).toString(),
      "faucet.testnet.get_config": { paused: true, cooldown_secs: "86400" },
    })));
    expect(s.tokens[0]).toMatchObject({ inStock: false, canClaim: false });
    expect(unavailableReason(s.tokens[0]!, false)).toMatch(/run out/);
    expect(unavailableReason(s.tokens[0]!, true)).toMatch(/paused/);
  });
  it("fails on an RPC error instead of showing an empty faucet", async () => {
    await expect(readFaucet("https://rpc", "faucet.testnet", null, NOW, async () => new Response("{}", { status: 503 }))).rejects.toThrow(/503/);
    await expect(readFaucet("https://rpc", "faucet.testnet", null, NOW, rpc({}))).rejects.toThrow(/no answer/);
  });
});

describe("claim call", () => {
  it("names only the token and attaches an upper-bound record deposit; the claimer is the signer", () => {
    const c = buildClaimCall("faucet.testnet", "backing-cashcat.testnet");
    expect(c.receiverId).toBe("faucet.testnet");
    expect(c.actions).toHaveLength(1);
    expect(c.actions[0]!.params.methodName).toBe("claim");
    expect(c.actions[0]!.params.args).toEqual({ token: "backing-cashcat.testnet" });
    expect(BigInt(c.actions[0]!.params.gas)).toBe(150_000_000_000_000n);
    expect(JSON.stringify(c)).not.toMatch(/receiver_id|account_id|recipient/);
  });
});

describe("formatWait", () => {
  it("formats waits", () => {
    expect(formatWait(0)).toBe("now");
    expect(formatWait(59 * 60_000)).toBe("59 min");
    expect(formatWait(23 * 3_600_000 + 30 * 60_000)).toBe("23 h 30 min");
  });
});

const entry = (over: Partial<FaucetEntry> = {}): FaucetEntry => ({ token: "t", symbol: "T", amount: "1", stock: "5", inStock: true, cooldownRemainingMs: 0, budgetLeft: null, canClaim: true, ...over });
describe("unavailableReason", () => {
  it("is null for a claimable token", () => {
    expect(unavailableReason(entry(), false)).toBeNull();
  });
});
