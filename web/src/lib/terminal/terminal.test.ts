import { describe, expect, it } from "vitest";
import { createMockArenaApi, MOCK_ACCOUNT } from "../arena/mock";
import { createMockTerminalChain } from "./chain";
import { executeDeposit, freezePlan } from "./executor";
import { createMockFundingRouter } from "./funding";
import { createTerminal, type TerminalController } from "./machine";
import { resolveIntent, type DepositPlan } from "./plan";
import { ruleBasedParser, parseWithRules } from "./rule-parser";
import { buildSummary, summaryText } from "./summary";
import { buildDepositTx, verifyTx } from "./transaction";
import type { ParsedIntent } from "./intent";

const T0 = 1_800_000_000_000;
const NEW_USER = "newbie.testnet"; // no credit, no positions

function setup(opts: { walletUsdc?: bigint } = {}) {
  const api = createMockArenaApi({ now: () => T0 });
  const chain = createMockTerminalChain(api, { now: () => T0, ...opts });
  const funding = createMockFundingRouter({ now: () => T0, onArrived: (a, n) => chain.credit(a, n) });
  return { api, chain, funding };
}

function intentOf(text: string): ParsedIntent {
  const r = parseWithRules(text);
  if (!r.ok) throw new Error(r.error);
  return r.intent;
}

async function readyPlan(text: string, account = NEW_USER, s = setup()): Promise<{ plan: DepositPlan; s: ReturnType<typeof setup> }> {
  const res = await resolveIntent(intentOf(text), { api: s.api, chain: s.chain, accountId: account, nowMs: T0 });
  if (res.kind !== "ready") throw new Error(`not ready: ${JSON.stringify(res)}`);
  return { plan: freezePlan(res.plan), s };
}

describe("resolveIntent", () => {
  it("resolves token and side to exactly one open battle side", async () => {
    const { plan } = await readyPlan("Deposit 50 USDC to $FLOKI");
    expect(plan).toMatchObject({ battleId: 2, side: "A", tokenSymbol: "FLOKI", totalUnits: 50_000_000n, creditUnits: 0n, walletUnits: 50_000_000n });
    expect(plan.expectedOut).toBeGreaterThan(0n);
    expect(plan.minOut).toBe((plan.expectedOut * 9900n) / 10000n);
  });

  it("asks a clarifying question when the side is ambiguous", async () => {
    const s = setup();
    const res = await resolveIntent({ ...intentOf("Deposit 10 USDC to battle 2"), token: undefined }, { api: s.api, chain: s.chain, accountId: NEW_USER, nowMs: T0 });
    expect(res.kind).toBe("clarify");
  });

  it("blocks unknown tokens and sides that contradict the token", async () => {
    const s = setup();
    const ctx = { api: s.api, chain: s.chain, accountId: NEW_USER, nowMs: T0 };
    expect((await resolveIntent(intentOf("Deposit 10 USDC to $WIF"), ctx)).kind).toBe("blocked");
    expect((await resolveIntent(intentOf("Deposit 10 USDC to $FLOKI tribe B"), ctx)).kind).toBe("blocked");
  });

  it("blocks battles that are not open for deposits", async () => {
    const s = setup();
    const res = await resolveIntent(intentOf("Deposit 10 USDC to battle 3 tribe A"), { api: s.api, chain: s.chain, accountId: NEW_USER, nowMs: T0 });
    expect(res).toMatchObject({ kind: "blocked" });
    expect(JSON.stringify(res)).toContain("Live");
  });

  it("blocks after the deposit deadline", async () => {
    const s = setup();
    const res = await resolveIntent(intentOf("Deposit 10 USDC to $FLOKI"), { api: s.api, chain: s.chain, accountId: NEW_USER, nowMs: T0 + 7 * 3_600_000 });
    expect(res).toMatchObject({ kind: "blocked" });
    expect(JSON.stringify(res)).toContain("closed");
  });

  it("blocks and shows the discrepancy when claimed credit exceeds available credit", async () => {
    const s = setup();
    const res = await resolveIntent(intentOf("Deposit 50 USDC to $FLOKI using 35 credit"), { api: s.api, chain: s.chain, accountId: NEW_USER, nowMs: T0 });
    expect(res.kind).toBe("blocked");
    expect(JSON.stringify(res)).toMatch(/asked to use \$35 of credit but only \$0 is available/);
  });

  it("uses real credit first for the demo account", async () => {
    const { plan } = await readyPlan("Deposit 50 USDC to $FLOKI using 35 credit", MOCK_ACCOUNT);
    expect(plan.creditUnits).toBe(35_000_000n);
    expect(plan.walletUnits).toBe(15_000_000n);
  });

  it("notes when credit is consumed beyond the claimed amount", async () => {
    const { plan } = await readyPlan("Deposit 50 USDC to $FLOKI using 10 credit", MOCK_ACCOUNT);
    expect(plan.creditUnits).toBe(35_000_000n);
    expect(plan.notes.join(" ")).toContain("Credit is always used first");
  });

  it("blocks when the wallet cannot cover the wallet part", async () => {
    const s = setup({ walletUsdc: 5_000_000n });
    const res = await resolveIntent(intentOf("Deposit 50 USDC to $FLOKI"), { api: s.api, chain: s.chain, accountId: NEW_USER, nowMs: T0 });
    expect(res.kind).toBe("blocked");
  });

  it("blocks backing the opposite side of an existing position", async () => {
    const s = setup();
    const res = await resolveIntent(intentOf("Deposit 5 USDC to $MOG"), { api: s.api, chain: s.chain, accountId: MOCK_ACCOUNT, nowMs: T0 });
    expect(res.kind).toBe("blocked");
  });

  it("plans a bridge leg for the other-chain part", async () => {
    const { plan } = await readyPlan("All-in $FLOKI with my remaining 35 USDC credit and add 15 USDC from my Base wallet", MOCK_ACCOUNT);
    expect(plan.creditUnits).toBe(35_000_000n);
    expect(plan.bridgeLegs).toEqual([{ chain: "base", amount: 15_000_000n }]);
    expect(plan.nearWalletUnits).toBe(0n);
    expect(plan.walletUnits).toBe(15_000_000n);
  });
});

describe("summary", () => {
  it("states battle, side, total, split, expected and minimum output, fees", async () => {
    const { plan } = await readyPlan("All-in $FLOKI with my remaining 35 USDC credit and add 15 USDC from my Base wallet", MOCK_ACCOUNT);
    const text = summaryText(buildSummary(plan));
    expect(text).toContain("Battle: #2");
    expect(text).toContain("Tribe A: $FLOKI");
    expect(text).toContain("Total: $50");
    expect(text).toContain("$35 credit + $0 NEAR wallet + $15 from Base");
    expect(text).toContain("Expected out:");
    expect(text).toContain("Minimum out:");
    expect(text).toContain("slippage 1.00%");
    expect(text).toContain("Fees:");
  });
});

describe("deposit transaction", () => {
  it("matches the message shape in the router protocol", async () => {
    const { plan } = await readyPlan("Deposit 50 USDC to $FLOKI");
    const tx = buildDepositTx(plan);
    expect(tx.method).toBe("ft_transfer_call");
    expect(tx.receiverId).toBe("usdc.tkn.testnet");
    expect(tx.deposit).toBe("1");
    expect(tx.args.receiver_id).toBe("arena.testnet");
    expect(tx.args.amount).toBe("50000000");
    expect(JSON.parse(tx.args.msg)).toEqual({
      action: "deposit_usdc",
      battle_id: 2,
      side: "A",
      total_usdc: "50000000",
      min_token_out: plan.minOut.toString(),
    });
  });

  it("sends only the wallet part as the transfer amount", async () => {
    const { plan } = await readyPlan("Deposit 50 USDC to $FLOKI using 35 credit", MOCK_ACCOUNT);
    const tx = buildDepositTx(plan);
    expect(tx.args.amount).toBe("15000000");
    expect(JSON.parse(tx.args.msg).total_usdc).toBe("50000000");
  });

  it("verifies a faithful transaction and flags every kind of drift", async () => {
    const { plan } = await readyPlan("Deposit 50 USDC to $FLOKI");
    const tx = buildDepositTx(plan);
    expect(verifyTx(plan, tx)).toEqual({ ok: true });
    const withMsg = (patch: Record<string, unknown>) => ({ ...tx, args: { ...tx.args, msg: JSON.stringify({ ...JSON.parse(tx.args.msg), ...patch }) } });
    expect(verifyTx(plan, { ...tx, receiverId: "evil.testnet" }).ok).toBe(false);
    expect(verifyTx(plan, { ...tx, args: { ...tx.args, receiver_id: "evil.testnet" } }).ok).toBe(false);
    expect(verifyTx(plan, { ...tx, args: { ...tx.args, amount: "50000001" } }).ok).toBe(false);
    expect(verifyTx(plan, { ...tx, deposit: "0" }).ok).toBe(false);
    expect(verifyTx(plan, withMsg({ side: "B" })).ok).toBe(false);
    expect(verifyTx(plan, withMsg({ battle_id: 3 })).ok).toBe(false);
    expect(verifyTx(plan, withMsg({ min_token_out: "0" })).ok).toBe(false);
    expect(verifyTx(plan, withMsg({ beneficiary: "evil.testnet" })).ok).toBe(false);
    expect(verifyTx(plan, { ...tx, args: { ...tx.args, msg: "not json" } }).ok).toBe(false);
  });
});

describe("executeDeposit", () => {
  it("aborts before signing when the built transaction differs from the confirmed summary", async () => {
    const { plan, s } = await readyPlan("Deposit 50 USDC to $FLOKI");
    const res = await executeDeposit(plan, plan, {
      ...s,
      sender: s.chain,
      buildTx: (p) => {
        const tx = buildDepositTx(p);
        return { ...tx, args: { ...tx.args, msg: JSON.stringify({ ...JSON.parse(tx.args.msg), side: "B" }) } };
      },
    });
    expect(res).toMatchObject({ ok: false, stage: "verify", deposited: false });
    expect(s.chain.sent).toHaveLength(0);
  });

  it("aborts when the live plan was changed after confirmation", async () => {
    const { plan, s } = await readyPlan("Deposit 50 USDC to $FLOKI");
    const tampered = { ...plan, totalUnits: 500_000_000n };
    const res = await executeDeposit(plan, tampered, { ...s, sender: s.chain });
    expect(res).toMatchObject({ ok: false, stage: "verify" });
    expect(s.chain.sent).toHaveLength(0);
  });

  it("deposits nothing when funding fails", async () => {
    const { plan, s } = await readyPlan("All-in $FLOKI with my remaining 35 USDC credit and add 15 USDC from my Base wallet", MOCK_ACCOUNT);
    const quote = await s.funding.quote({ chain: "base", amount: 15_000_000n, recipient: MOCK_ACCOUNT, refundTo: "0xabc123" });
    s.funding.setFailure("bridge halted");
    const before = await s.chain.usdcBalance(MOCK_ACCOUNT);
    const res = await executeDeposit(plan, plan, { ...s, sender: s.chain }, { fundingQuotes: [quote] });
    expect(res).toMatchObject({ ok: false, stage: "funding", deposited: false });
    expect(s.chain.sent).toHaveLength(0);
    expect(await s.chain.usdcBalance(MOCK_ACCOUNT)).toBe(before);
  });

  it("refuses to run a bridge plan without a matching quote", async () => {
    const { plan, s } = await readyPlan("Deposit 20 USDC to $FLOKI, 20 USDC from Base");
    expect(await executeDeposit(plan, plan, { ...s, sender: s.chain }, { fundingQuotes: [] })).toMatchObject({ ok: false, stage: "funding" });
    const wrong = await s.funding.quote({ chain: "base", amount: 1_000_000n, recipient: NEW_USER, refundTo: "0xabc123" });
    expect(await executeDeposit(plan, plan, { ...s, sender: s.chain }, { fundingQuotes: [wrong] })).toMatchObject({ ok: false, stage: "funding" });
    expect(s.chain.sent).toHaveLength(0);
  });

  it("aborts when the wallet is short after funding (bridge fee)", async () => {
    const s = setup({ walletUsdc: 0n });
    const { plan } = await readyPlan("Deposit 20 USDC to $FLOKI, 20 USDC from Base", NEW_USER, s);
    const quote = await s.funding.quote({ chain: "base", amount: 20_000_000n, recipient: NEW_USER, refundTo: "0xabc123" });
    const res = await executeDeposit(plan, plan, { ...s, sender: s.chain }, { fundingQuotes: [quote] });
    expect(res).toMatchObject({ ok: false, stage: "balance", deposited: false });
  });

  it("reports a failed send as not deposited", async () => {
    const { plan, s } = await readyPlan("Deposit 50 USDC to $FLOKI");
    s.chain.failNextSend("user rejected");
    expect(await executeDeposit(plan, plan, { ...s, sender: s.chain })).toMatchObject({ ok: false, stage: "send", reason: "user rejected" });
  });
});

describe("terminal state machine (mock api end to end)", () => {
  function terminal(account: string | null = NEW_USER, scopeBattleId?: number) {
    const s = setup();
    const t = createTerminal({ parser: ruleBasedParser, api: s.api, chain: s.chain, sender: s.chain, funding: s.funding, getAccountId: () => account, now: () => T0, scopeBattleId });
    return { ...s, t };
  }
  const phase = (t: TerminalController) => t.getState().phase;

  it("runs prompt -> summary -> confirm -> deposit", async () => {
    const { t, api, chain } = terminal();
    await t.submit("Deposit 50 USDC to $FLOKI");
    expect(phase(t)).toBe("confirm");
    expect(chain.sent).toHaveLength(0);
    const before = BigInt((await api.getBattle(2))!.vault_a);
    await t.confirm();
    expect(phase(t)).toBe("done");
    expect(chain.sent).toHaveLength(1);
    expect(BigInt((await api.getBattle(2))!.vault_a)).toBeGreaterThan(before);
    expect((await api.getPosition(2, NEW_USER))?.side).toBe("A");
    expect(await chain.usdcBalance(NEW_USER)).toBe(50_000_000n);
  });

  it("does not execute until confirmed and can be cancelled", async () => {
    const { t, chain } = terminal();
    await t.submit("Deposit 50 USDC to $FLOKI");
    t.cancel();
    expect(phase(t)).toBe("idle");
    expect(chain.sent).toHaveLength(0);
  });

  it("asks a question for an ambiguous prompt and does not execute; a reply completes it", async () => {
    const { t, chain } = terminal();
    await t.submit("Deposit 10 USDC");
    expect(t.getState()).toMatchObject({ phase: "clarify" });
    await t.submit("to $FLOKI");
    expect(phase(t)).toBe("confirm");
    expect(chain.sent).toHaveLength(0);
  });

  it("blocks a credit claim the account cannot back", async () => {
    const { t, chain } = terminal();
    await t.submit("Deposit 50 USDC to $FLOKI using 35 credit");
    expect(t.getState()).toMatchObject({ phase: "blocked" });
    await t.confirm();
    expect(chain.sent).toHaveLength(0);
  });

  it("scopes prompts to the battle page", async () => {
    const { t } = terminal(NEW_USER, 3);
    await t.submit("Deposit 10 USDC to $MOG");
    expect(t.getState()).toMatchObject({ phase: "blocked" });
  });

  it("requires a connected wallet", async () => {
    const { t } = terminal(null);
    await t.submit("Deposit 10 USDC to $FLOKI");
    expect(t.getState()).toMatchObject({ phase: "error" });
  });

  it("goes through quote and funding confirmation for a hybrid prompt", async () => {
    const { t, chain } = terminal(MOCK_ACCOUNT);
    await t.submit("All-in $FLOKI with my remaining 35 USDC credit and add 15 USDC from my Base wallet");
    expect(phase(t)).toBe("confirm");
    await t.confirm({});
    expect(t.getState()).toMatchObject({ phase: "error" }); // refund address missing
    await t.submit("All-in $FLOKI with my remaining 35 USDC credit and add 15 USDC from my Base wallet");
    await t.confirm({ base: "0xabc123" });
    expect(phase(t)).toBe("funding_confirm");
    expect(chain.sent).toHaveLength(0);
    await t.confirmFunding();
    expect(phase(t)).toBe("done");
    expect(chain.sent).toHaveLength(1);
    expect(JSON.parse(chain.sent[0]!.args.msg).total_usdc).toBe("50000000");
  });

  it("shows a failed state and deposits nothing when funding fails", async () => {
    const { t, chain, funding } = terminal(MOCK_ACCOUNT);
    await t.submit("All-in $FLOKI with my remaining 35 USDC credit and add 15 USDC from my Base wallet");
    await t.confirm({ base: "0xabc123" });
    funding.setFailure("route unavailable");
    await t.confirmFunding();
    expect(t.getState()).toMatchObject({ phase: "failed", result: { stage: "funding", deposited: false } });
    expect(chain.sent).toHaveLength(0);
  });

  it("shows a failed state when the wallet rejects", async () => {
    const { t, chain } = terminal();
    await t.submit("Deposit 50 USDC to $FLOKI");
    chain.failNextSend("rejected by user");
    await t.confirm();
    expect(t.getState()).toMatchObject({ phase: "failed", result: { stage: "send" } });
  });
});
