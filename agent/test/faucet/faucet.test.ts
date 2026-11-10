// FIXTURE-ONLY: a fake chain and fake sessions. Nothing here touches NEAR.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadFaucetConfig, parseFaucetTokens, type FaucetConfig } from "../../src/faucet/config.js";
import { handleFaucetRequest } from "../../src/faucet/http.js";
import { FaucetLedger } from "../../src/faucet/ledger.js";
import { FaucetService, type FaucetChain } from "../../src/faucet/service.js";

const E18 = 10n ** 18n;
const cfg: FaucetConfig = {
  account: "faucet.testnet",
  tokens: [
    { symbol: "CASHCAT", representation: "backing-cashcat.testnet", amount: (100n * E18).toString() },
    { symbol: "WALLET", representation: "backing-wallet.testnet", amount: (100n * E18).toString() },
  ],
  cooldownMs: 24 * 3_600_000,
  maxPerHour: 3,
};

class FakeChain implements FaucetChain {
  balances = new Map<string, bigint>([["backing-cashcat.testnet", 1_000n * E18], ["backing-wallet.testnet", 1_000n * E18]]);
  registered = new Set<string>();
  calls: string[] = [];
  failTransfer = false;
  async balanceOf(token: string) { return this.balances.get(token) ?? 0n; }
  async isRegistered(token: string, account: string) { return this.registered.has(`${token}|${account}`); }
  async storageMin() { return 1_250_000_000_000_000_000_000n; }
  async register(token: string, account: string, deposit: bigint) { this.calls.push(`register ${token} ${account} ${deposit}`); this.registered.add(`${token}|${account}`); }
  async transfer(token: string, receiver: string, amount: bigint) {
    if (this.failTransfer) throw new Error("rpc down");
    this.calls.push(`transfer ${token} ${receiver} ${amount}`);
    this.balances.set(token, (this.balances.get(token) ?? 0n) - amount);
    return `hash-${this.calls.length}`;
  }
}

let clock = 1_000_000;
let chain: FakeChain;
let ledger: FaucetLedger;
const make = (live = true, config = cfg) => new FaucetService(config, chain, ledger, { live, now: () => clock });

beforeEach(() => { clock = 1_000_000; chain = new FakeChain(); ledger = new FaucetLedger(null); });

describe("faucet claims", () => {
  it("registers storage first and then transfers, once per account and token", async () => {
    const f = make();
    const [a, b] = await f.claim("alice.testnet");
    expect(a).toMatchObject({ symbol: "CASHCAT", status: "sent", txHash: "hash-2" });
    expect(b).toMatchObject({ symbol: "WALLET", status: "sent" });
    expect(chain.calls[0]).toBe("register backing-cashcat.testnet alice.testnet 1250000000000000000000");
    expect(chain.calls[1]).toBe(`transfer backing-cashcat.testnet alice.testnet ${100n * E18}`);
  });
  it("does not register storage again for an account that already has it", async () => {
    chain.registered.add("backing-cashcat.testnet|alice.testnet");
    await make().claim("alice.testnet", ["cashcat"]);
    expect(chain.calls.filter((c) => c.startsWith("register"))).toEqual([]);
  });
  it("sends nothing inside the cooldown and says how long remains, then allows a new claim", async () => {
    const f = make();
    await f.claim("alice.testnet", ["CASHCAT"]);
    clock += 3_600_000;
    const [again] = await f.claim("alice.testnet", ["CASHCAT"]);
    expect(again).toMatchObject({ status: "cooldown", retryAfterMs: 23 * 3_600_000 });
    clock += 23 * 3_600_000;
    expect((await f.claim("alice.testnet", ["CASHCAT"]))[0]!.status).toBe("sent");
  });
  it("keeps accounts and tokens separate", async () => {
    const f = make();
    await f.claim("alice.testnet", ["CASHCAT"]);
    expect((await f.claim("bob.testnet", ["CASHCAT"]))[0]!.status).toBe("sent");
    expect((await f.claim("alice.testnet", ["WALLET"]))[0]!.status).toBe("sent");
  });
  it("never sends a partial amount when the faucet is nearly empty", async () => {
    chain.balances.set("backing-cashcat.testnet", 99n * E18);
    const [r] = await make().claim("alice.testnet", ["CASHCAT"]);
    expect(r).toMatchObject({ status: "empty" });
    expect(chain.calls).toEqual([]);
  });
  it("is a dry run unless live: nothing is sent or recorded", async () => {
    const f = make(false);
    expect((await f.claim("alice.testnet", ["CASHCAT"]))[0]).toMatchObject({ status: "dry_run" });
    expect(chain.calls).toEqual([]);
    expect(ledger.lastClaim("alice.testnet", "CASHCAT")).toBeNull();
    expect((await make(false).claim("alice.testnet", ["CASHCAT"]))[0]!.status).toBe("dry_run");
  });
  it("bounds the total transfers per hour", async () => {
    const f = make();
    await f.claim("a.testnet", ["CASHCAT"]);
    await f.claim("b.testnet", ["CASHCAT"]);
    await f.claim("c.testnet", ["CASHCAT"]);
    expect((await f.claim("d.testnet", ["CASHCAT"]))[0]).toMatchObject({ status: "hourly_limit" });
    clock += 3_700_000;
    expect((await f.claim("d.testnet", ["CASHCAT"]))[0]!.status).toBe("sent");
  });
  it("releases the claim when the transfer fails so the account can try again", async () => {
    chain.failTransfer = true;
    const f = make();
    expect((await f.claim("alice.testnet", ["CASHCAT"]))[0]).toMatchObject({ status: "error", message: "rpc down" });
    expect(ledger.lastClaim("alice.testnet", "CASHCAT")).toBeNull();
    chain.failTransfer = false;
    expect((await f.claim("alice.testnet", ["CASHCAT"]))[0]!.status).toBe("sent");
  });
  it("does not pay twice when the same account claims in parallel", async () => {
    const f = make();
    const [x, y] = await Promise.all([f.claim("alice.testnet", ["CASHCAT"]), f.claim("alice.testnet", ["CASHCAT"])]);
    expect([x![0]!.status, y![0]!.status].sort()).toEqual(["cooldown", "sent"]);
    expect(chain.calls.filter((c) => c.startsWith("transfer"))).toHaveLength(1);
  });
  it("refuses the faucet account, malformed accounts and unknown tokens", async () => {
    const f = make();
    await expect(f.claim("faucet.testnet")).rejects.toThrow(/cannot claim/);
    await expect(f.claim("NOT AN ACCOUNT")).rejects.toThrow(/cannot claim/);
    await expect(f.claim("alice.testnet", ["PEPE"])).rejects.toThrow(/unknown token/);
  });
  it("reports status with cooldown and availability", async () => {
    const f = make();
    await f.claim("alice.testnet", ["CASHCAT"]);
    chain.balances.set("backing-wallet.testnet", 0n);
    const s = await f.status("alice.testnet");
    expect(s.find((t) => t.symbol === "CASHCAT")).toMatchObject({ cooldownRemainingMs: 24 * 3_600_000, available: true });
    expect(s.find((t) => t.symbol === "WALLET")).toMatchObject({ cooldownRemainingMs: 0, available: false });
  });
});

describe("faucet ledger", () => {
  it("survives a restart and refuses a malformed file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "faucet-")), "ledger.json");
    const a = new FaucetLedger(path);
    a.reserve("alice.testnet", "CASHCAT", 5_000);
    a.complete("alice.testnet", "CASHCAT", "h1");
    expect(new FaucetLedger(path).lastClaim("alice.testnet", "CASHCAT")).toEqual({ at: 5_000, txHash: "h1", pending: false });
    writeFileSync(path, "{bad");
    expect(() => new FaucetLedger(path)).toThrow();
    writeFileSync(path, JSON.stringify({ version: 2 }));
    expect(() => new FaucetLedger(path)).toThrow(/malformed/);
  });
  it("keeps a reserved claim in cooldown if the process dies before the transfer finishes", () => {
    const path = join(mkdtempSync(join(tmpdir(), "faucet-")), "ledger.json");
    new FaucetLedger(path).reserve("alice.testnet", "CASHCAT", 9_000);
    expect(new FaucetLedger(path).lastClaim("alice.testnet", "CASHCAT")).toMatchObject({ pending: true });
  });
});

describe("faucet config", () => {
  const tokens = JSON.stringify([{ symbol: "cashcat", representation: "backing-cashcat.testnet", amount: "1000" }]);
  it("reads the environment with conservative defaults and uppercases symbols", () => {
    const c = loadFaucetConfig({ FAUCET_ACCOUNT_ID: "faucet.testnet", FAUCET_TOKENS: tokens });
    expect(c).toMatchObject({ account: "faucet.testnet", cooldownMs: 24 * 3_600_000, maxPerHour: 120 });
    expect(c.tokens[0]!.symbol).toBe("CASHCAT");
  });
  it("rejects bad settings with a message that names the variable", () => {
    expect(() => loadFaucetConfig({ FAUCET_ACCOUNT_ID: "", FAUCET_TOKENS: tokens })).toThrow(/FAUCET_ACCOUNT_ID/);
    expect(() => loadFaucetConfig({ FAUCET_ACCOUNT_ID: "f.testnet", FAUCET_TOKENS: "nope" })).toThrow(/FAUCET_TOKENS/);
    expect(() => loadFaucetConfig({ FAUCET_ACCOUNT_ID: "f.testnet", FAUCET_TOKENS: tokens, FAUCET_COOLDOWN_HOURS: "0" })).toThrow(/COOLDOWN/);
    expect(() => parseFaucetTokens([{ symbol: "A", representation: "x.testnet", amount: "0" }])).toThrow(/amount/);
    expect(() => parseFaucetTokens([{ symbol: "A", representation: "x.testnet", amount: "1" }, { symbol: "a", representation: "y.testnet", amount: "1" }])).toThrow(/repeats/);
  });
});

describe("faucet http", () => {
  const accountOf = (t: unknown) => {
    if (t === "tok-alice") return "alice.testnet";
    throw new Error("bad");
  };
  const call = (method: string, url: string, authorization?: string, body = "") => handleFaucetRequest({ method, url, authorization, body }, { faucet: make(), accountOf });
  it("requires a valid read session and never takes the account from the body", async () => {
    expect((await call("GET", "/faucet/status")).status).toBe(401);
    expect((await call("GET", "/faucet/status", "Bearer nope")).status).toBe(401);
    const claimed = await call("POST", "/faucet/claim", "Bearer tok-alice", JSON.stringify({ tokens: ["CASHCAT"] }));
    expect(claimed.status).toBe(200);
    expect(JSON.parse(claimed.body).account).toBe("alice.testnet");
    expect(chain.calls.some((c) => c.includes("alice.testnet"))).toBe(true);
    expect((await call("POST", "/faucet/claim", "Bearer tok-alice", JSON.stringify({ account: "bob.testnet" }))).status).toBe(400);
  });
  it("reports status and rejects wrong methods, bad bodies and unknown routes", async () => {
    const s = JSON.parse((await call("GET", "/faucet/status", "Bearer tok-alice")).body);
    expect(s).toMatchObject({ account: "alice.testnet", live: true });
    expect(s.tokens).toHaveLength(2);
    expect((await call("POST", "/faucet/status", "Bearer tok-alice")).status).toBe(405);
    expect((await call("GET", "/faucet/claim", "Bearer tok-alice")).status).toBe(405);
    expect((await call("POST", "/faucet/claim", "Bearer tok-alice", "{bad")).status).toBe(400);
    expect((await call("POST", "/faucet/claim", "Bearer tok-alice", "[1]")).status).toBe(400);
    expect((await call("POST", "/faucet/claim", "Bearer tok-alice", JSON.stringify({ tokens: ["a b"] }))).status).toBe(400);
    expect((await call("POST", "/faucet/claim", "Bearer tok-alice", JSON.stringify({ tokens: ["PEPE"] }))).status).toBe(400);
    expect((await call("POST", "/faucet/claim", "Bearer tok-alice", "x".repeat(3_000))).status).toBe(413);
    expect((await call("GET", "/other", "Bearer tok-alice")).status).toBe(404);
  });
});
