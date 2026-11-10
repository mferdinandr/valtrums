// Reads the recorded deploy evidence. Builds text only; nothing is sent.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run } from "../../src/faucet/funding-plan-cli.js";
import { attestArgsFromVerifyOutput, attestCommand, buildPlan, loadFundingFacts } from "../../src/faucet/funding-plan.js";

const dir = new URL("../../../docs/evidence/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, dir), "utf8"));
const facts = loadFundingFacts(read);
const opts = { faucet: "valtrum-faucet.testnet", operator: "valtrum-operator.testnet", battleId: "7", depositor: "0x1111111111111111111111111111111111111111", tokens: 1_000_000 };

describe("funding facts", () => {
  it("come from the recorded evidence, for all six tokens", () => {
    expect(facts.backings.map((b) => b.symbol).sort()).toEqual(["AI", "CASHCAT", "DEGEN", "GOOD", "VLAD", "WALLET"]);
    expect(facts.mappingVersion).toBe("3");
    expect(facts.forwarder).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(facts.holder).not.toBe(facts.forwarder);
    expect(facts.custodyDomain).toBe("0xb994dcab6ad9a042e7bbec3ba104ec5e6b797798");
    expect(facts.retired).toContain("0xb994DCAb6aD9a042e7bBec3Ba104Ec5e6b797798");
  });
  it("fail with a specific message on malformed evidence", () => {
    expect(() => loadFundingFacts(() => ({}))).toThrow(/forwarder/);
  });
});

describe("funding plan", () => {
  it("covers every token with the full chain of steps and the stock asked for", () => {
    const steps = buildPlan(facts, opts);
    for (const b of facts.backings) {
      const mine = steps.filter((s) => s.id.startsWith(`${b.symbol.toLowerCase()}-`)).map((s) => s.id.split("-").slice(1).join("-"));
      expect(mine, b.symbol).toEqual(["mint", "approve", "deposit", "logindex", "finality", "verify", "attest", "register", "claim-receipt", "claim-representation", "register-faucet", "stock", "offer", "check"]);
    }
    const mint = steps.find((s) => s.id === "cashcat-mint")!;
    expect(mint.command).toContain((1_000_000n * 10n ** 18n).toString());
  });
  it("binds the deposit to the battle, the mapping version, the faucet account and the recorded contracts", () => {
    const deposit = buildPlan(facts, opts).find((s) => s.id === "cashcat-deposit")!;
    const cashcat = facts.backings.find((b) => b.symbol === "CASHCAT")!;
    expect(deposit.command).toContain(`"deposit(address,uint64,uint64,address,string,uint256)" ${cashcat.token} 7 3 ${opts.depositor} valtrum-operator.testnet`);
    expect(deposit.command).toContain(facts.forwarder);
    expect(deposit.signer).toMatch(/DEPOSITOR_PRIVATE_KEY/);
  });
  it("never contains a key value and refers to keys by variable name only", () => {
    const all = JSON.stringify(buildPlan(facts, opts));
    expect(all).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{20,}/);
    expect(all).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(all).toMatch(/\$DEPLOYER_PRIVATE_KEY/);
  });
  it("deploys the contract, sends the stock to it and offers each token with the claim and daily amounts", () => {
    const steps = buildPlan(facts, { ...opts, claimTokens: 50, dailyTokens: 5_000, symbols: ["cashcat"] });
    const ids = steps.map((s) => s.id);
    expect(ids.indexOf("prereq-deploy")).toBeGreaterThan(ids.indexOf("prereq-build"));
    expect(ids.indexOf("cashcat-stock")).toBeGreaterThan(ids.indexOf("cashcat-claim-representation"));
    const offer = steps.find((s) => s.id === "cashcat-offer")!;
    expect(offer.command).toContain(`"amount":"${50n * 10n ** 18n}","daily_budget":"${5_000n * 10n ** 18n}"`);
    expect(offer.command).toContain('"symbol":"CASHCAT"');
    expect(steps.find((s) => s.id === "prereq-deploy")!.command).toContain('"owner":"valtrum-operator.testnet"');
    expect(steps.find((s) => s.id === "go-live")!.command).toContain("NEXT_PUBLIC_FAUCET_CONTRACT_ID=valtrum-faucet.testnet");
  });
  it("marks which steps send a transaction and starts with the read-only checks", () => {
    const steps = buildPlan(facts, { ...opts, symbols: ["degen"] });
    expect(steps[0]!.id).toBe("prereq-battle");
    expect(steps[0]!.mutating).toBe(false);
    expect(steps.find((s) => s.id === "degen-mint")!.mutating).toBe(true);
    expect(steps.find((s) => s.id === "degen-verify")!.mutating).toBe(false);
    expect(steps.some((s) => s.id.startsWith("cashcat"))).toBe(false);
  });
  it("rejects bad inputs with every reason", () => {
    expect(() => buildPlan(facts, { ...opts, faucet: "BAD", battleId: "0", depositor: "0x12", tokens: 0 })).toThrow(/faucet account.*battle id.*depositor.*tokens/);
    expect(() => buildPlan(facts, { ...opts, operator: opts.faucet })).toThrow(/different accounts/);
    expect(() => buildPlan(facts, { ...opts, claimTokens: 100, dailyTokens: 50 })).toThrow(/daily budget/);
    expect(() => buildPlan(facts, { ...opts, symbols: ["PEPE"] })).toThrow(/unknown token PEPE/);
  });
});

describe("attest call", () => {
  const hex = (n: number, len: number) => "0x" + n.toString(16).padStart(2, "0").repeat(len);
  const output = (verdict = "verified") => ({
    chainId: "46630", tx: "0xabc",
    timeline: [{ verdict: "pending" }, {
      verdict,
      attestation: {
        chainId: "46630", transactionHash: hex(1, 32), logIndex: 1, representation: "backing-cashcat.valtrum-owner-b694.testnet",
        token: "0x5B2BA17E5BE1B611C1299809DB89C5FE21D9D0A6", custodyDomain: facts.custodyDomain, mappingVersion: "3", beneficiary: "valtrum-faucet.testnet",
        refundAddress: "0x1111111111111111111111111111111111111111", battleId: "7", actualReceived: "1000000000000000000000000",
        blockNumber: "150700000", blockHash: hex(2, 32), finalizedHeadNumber: "150700100", finalizedHeadHash: hex(3, 32), evidenceHash: hex(4, 32),
      },
    }],
  });
  it("turns the verified attestation into the registry arguments", () => {
    const a = attestArgsFromVerifyOutput(output());
    expect(a.key).toEqual({ chain_id: "46630", transaction_hash: Array(32).fill(1), log_index: 1 });
    expect(a.claim).toMatchObject({ token_address: "0x5b2ba17e5be1b611c1299809db89c5fe21d9d0a6", mapping_version: "3", battle_id: "7", actual_received: "1000000000000000000000000", refund_address: Array(20).fill(0x11) });
    const cmd = attestCommand(facts, a);
    expect(cmd).toContain(`${facts.registry} attest json-args`);
    expect(cmd).toContain(`sign-as ${facts.verifier}`);
    expect(cmd).toContain("attached-deposit '1 yoctoNEAR'");
  });
  it("refuses anything that is not a verified verdict or is malformed", () => {
    expect(() => attestArgsFromVerifyOutput(output("pending"))).toThrow(/not verified/);
    expect(() => attestArgsFromVerifyOutput(output("rejected"))).toThrow(/not verified/);
    expect(() => attestArgsFromVerifyOutput({})).toThrow(/timeline/);
    const bad = output();
    (bad.timeline[1] as { attestation: { blockHash: string } }).attestation.blockHash = "0x12";
    expect(() => attestArgsFromVerifyOutput(bad)).toThrow(/blockHash/);
  });
});

describe("funding plan cli", () => {
  it("prints a plan that says nothing was sent, with all six tokens by default", () => {
    const text = run(["plan", "--faucet", "valtrum-faucet.testnet", "--operator", "valtrum-operator.testnet", "--battle", "7", "--depositor", "0x1111111111111111111111111111111111111111", "--evidence-dir", new URL(".", dir).pathname]);
    expect(text).toMatch(/NOTHING HAS BEEN SENT/);
    for (const s of ["CASHCAT", "WALLET", "GOOD", "AI", "VLAD", "DEGEN"]) expect(text).toContain(`${s}: mint 1000000 mock tokens`);
  });
  it("needs its inputs", () => {
    expect(() => run(["plan", "--evidence-dir", new URL(".", dir).pathname])).toThrow(/needs --faucet/);
    expect(() => run(["wat", "--evidence-dir", new URL(".", dir).pathname])).toThrow(/usage/);
  });
});
