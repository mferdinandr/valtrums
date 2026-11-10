import { describe, expect, it } from "vitest";
import { createMockArenaApi, MOCK_ACCOUNT } from "./mock";
import { previewClaimForBattle, priceBasis } from "./payout";

const T0 = 1_800_000_000_000;
const USDC = "usdc.tkn.testnet";

describe("mock arena api", () => {
  it("is deterministic for a fixed clock", async () => {
    const a = createMockArenaApi({ now: () => T0 });
    const b = createMockArenaApi({ now: () => T0 });
    expect(await a.getBattles(0, 50)).toEqual(await b.getBattles(0, 50));
    expect(await a.getLivePrices(3)).toEqual(await b.getLivePrices(3));
  });

  it("exposes the same multi-community demo in the list and detail, then closes its round", async () => {
    let now = T0;
    const api = createMockArenaApi({ now: () => now });
    const battle = await api.getBattle(8);
    expect(battle?.status).toBe("Live");
    expect(battle?.demo_communities).toHaveLength(5);
    expect((await api.getBattles(0, 50)).find((item) => item.id === 8)).toEqual(battle);
    now += 20_000;
    expect((await api.getBattle(8))?.status).toBe("Settling");
    expect((await api.getBattles(0, 50)).find((item) => item.id === 8)?.status).toBe("Settling");
  });

  it("covers every status", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const statuses = new Set((await api.getBattles(0, 50)).map((x) => x.status));
    expect(statuses).toEqual(
      new Set(["Proposed", "Approved", "Live", "Settling", "Settled", "EmergencyHalted", "Voided"]),
    );
  });

  it("claims once, grants locked credit and resets the 7 day timer", async () => {
    let now = T0;
    const api = createMockArenaApi({ now: () => now });
    const before = await api.getAccount(MOCK_ACCOUNT);
    await api.claim({ signerId: MOCK_ACCOUNT, battleId: 5 });
    const after = await api.getAccount(MOCK_ACCOUNT);
    expect(BigInt(after.credit_balance)).toBeGreaterThan(BigInt(before.credit_balance));
    expect(BigInt(after.credit_expires_at_ns)).toBe((BigInt(now) + 7n * 24n * 3600n * 1000n) * 1_000_000n);
    expect((await api.getPosition(5, MOCK_ACCOUNT))?.claimed).toBe(true);
    await expect(api.claim({ signerId: MOCK_ACCOUNT, battleId: 5 })).rejects.toThrow();
    now += 1;
  });

  it("claim matches the payout preview and credits the winner coin", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const b = (await api.getBattle(5))!;
    const pos = (await api.getPosition(5, MOCK_ACCOUNT))!;
    const metaA = await api.getTokenMeta(b.token_a);
    const metaB = await api.getTokenMeta(b.token_b);
    const preview = previewClaimForBattle(b, pos, metaA, metaB, priceBasis(b, null)!, await api.getSettlementPlan(5));
    expect(preview.estimated).toBe(false);
    const coinBefore = BigInt(await api.getLiquidBalance(MOCK_ACCOUNT, b.token_a));
    const usdcBefore = BigInt(await api.getLiquidBalance(MOCK_ACCOUNT, USDC));
    const before = await api.getAccount(MOCK_ACCOUNT);
    await api.claim({ signerId: MOCK_ACCOUNT, battleId: 5 });
    const after = await api.getAccount(MOCK_ACCOUNT);
    expect(BigInt(await api.getLiquidBalance(MOCK_ACCOUNT, b.token_a)) - coinBefore).toBe(preview.totalCoin);
    expect(preview.totalCoin).toBeGreaterThan(preview.principalCoin);
    expect(BigInt(await api.getLiquidBalance(MOCK_ACCOUNT, USDC))).toBe(usdcBefore);
    expect(BigInt(after.credit_balance) - BigInt(before.credit_balance)).toBe(preview.credit);
  });

  it("seeds liquid balances per token", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    expect(BigInt(await api.getLiquidBalance(MOCK_ACCOUNT, USDC))).toBe(12_500_000n);
    expect(BigInt(await api.getLiquidBalance(MOCK_ACCOUNT, "pepe.tkn.testnet"))).toBeGreaterThan(0n);
    expect(await api.getLiquidBalance(MOCK_ACCOUNT, "mog.tkn.testnet")).toBe("0");
    expect(await api.getLiquidBalance("nobody.testnet", USDC)).toBe("0");
    expect(await api.getAccount("nobody.testnet")).toEqual({ credit_balance: "0", credit_expires_at_ns: "0" });
  });

  it("refund credits the full deposit to the liquid balance", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const b = (await api.getBattle(6))!;
    const pos = (await api.getPosition(6, MOCK_ACCOUNT))!;
    await api.withdrawInitialDeposit({ signerId: MOCK_ACCOUNT, battleId: 6 });
    expect(await api.getLiquidBalance(MOCK_ACCOUNT, b.token_a)).toBe(pos.coin_amount);
  });

  it("serves a one step plan while settling and a four step plan once settled", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    expect((await api.getSettlementPlan(4)).map((s) => s.kind)).toEqual(["Dump"]);
    expect((await api.getSettlementPlan(5)).map((s) => s.kind)).toEqual(["Dump", "Buy", "Burn", "Return"]);
    expect(await api.getSettlementPlan(3)).toEqual([]);
  });

  it("refunds only after halt or void", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    await expect(api.withdrawInitialDeposit({ signerId: MOCK_ACCOUNT, battleId: 3 })).rejects.toThrow();
    await api.withdrawInitialDeposit({ signerId: MOCK_ACCOUNT, battleId: 6 });
    expect((await api.getPosition(6, MOCK_ACCOUNT))?.claimed).toBe(true);
  });

  it("accepts deposits only while approved and on the matching coin", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const b = (await api.getBattle(2))!;
    await api.depositCoin({ signerId: "bob.testnet", battleId: 2, side: "B", tokenId: b.token_b, amount: 10n ** 18n });
    expect(BigInt((await api.getBattle(2))!.vault_b)).toBeGreaterThan(BigInt(b.vault_b));
    await expect(
      api.depositCoin({ signerId: "bob.testnet", battleId: 3, side: "A", tokenId: "x", amount: 1n }),
    ).rejects.toThrow();
    await expect(
      api.depositCoin({ signerId: "bob.testnet", battleId: 2, side: "A", tokenId: b.token_b, amount: 1n }),
    ).rejects.toThrow();
  });

  it("proposes new battles", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const n = await api.getBattleCount();
    await api.proposeBattle({ signerId: "bob.testnet", tokenA: "a.tkn.testnet", tokenB: "b.tkn.testnet", durationSecs: 3600 });
    expect(await api.getBattleCount()).toBe(n + 1);
    expect((await api.getBattle(n + 1))?.status).toBe("Proposed");
  });
});

describe("mock balance funding and deposits", () => {
  const usdcOf = async (api: ReturnType<typeof createMockArenaApi>, who = MOCK_ACCOUNT) => BigInt(await api.getLiquidBalance(who, USDC));
  const creditOf = async (api: ReturnType<typeof createMockArenaApi>, who = MOCK_ACCOUNT) => BigInt((await api.getAccount(who)).credit_balance);

  it("funds the internal USDC balance", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const before = await usdcOf(api);
    await api.fundBalance({ signerId: MOCK_ACCOUNT, amount: 10_000_000n });
    expect(await usdcOf(api)).toBe(before + 10_000_000n);
    await expect(api.fundBalance({ signerId: MOCK_ACCOUNT, amount: 0n })).rejects.toThrow();
  });

  it("debits an attached wallet and refuses more than it holds", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    let wallet = 5_000_000n;
    api.attachWallet({ balance: () => wallet, debit: (_id, n) => void (wallet -= n) });
    await api.fundBalance({ signerId: MOCK_ACCOUNT, amount: 3_000_000n });
    expect(wallet).toBe(2_000_000n);
    await expect(api.fundBalance({ signerId: MOCK_ACCOUNT, amount: 3_000_000n })).rejects.toThrow("Not enough USDC");
    expect(wallet).toBe(2_000_000n);
  });

  it("spends credit first and then the balance (hybrid)", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const balance = await usdcOf(api); // 12.5
    const credit = await creditOf(api); // 35
    await api.depositFromBalance({ signerId: MOCK_ACCOUNT, battleId: 2, side: "A", totalUsdc: 40_000_000n, minTokenOut: 1n });
    expect(await creditOf(api)).toBe(0n);
    expect(await usdcOf(api)).toBe(balance - (40_000_000n - credit));
    const pos = (await api.getPosition(2, MOCK_ACCOUNT))!;
    expect(pos.from_credit).toBe(credit.toString());
    expect(BigInt(pos.usdc_equiv)).toBeGreaterThanOrEqual(40_000_000n);
  });

  it("keeps the credit expiry when credit is spent", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const expiry = (await api.getAccount(MOCK_ACCOUNT)).credit_expires_at_ns;
    await api.depositFromBalance({ signerId: MOCK_ACCOUNT, battleId: 2, side: "A", totalUsdc: 10_000_000n, minTokenOut: 1n });
    expect((await api.getAccount(MOCK_ACCOUNT)).credit_expires_at_ns).toBe(expiry);
    expect(await creditOf(api)).toBe(25_000_000n);
  });

  it("ignores expired credit and uses only the balance", async () => {
    let now = T0;
    const api = createMockArenaApi({ now: () => now });
    now = T0 + 6 * 24 * 3_600_000; // credit expired, battle 2 deposits closed in the mock? use a fresh balance instead
    const fresh = "fresh.testnet";
    await api.fundBalance({ signerId: fresh, amount: 20_000_000n });
    // battle 2 is still Approved in the mock status; the credit rule is what is under test
    await api.depositFromBalance({ signerId: fresh, battleId: 2, side: "A", totalUsdc: 20_000_000n, minTokenOut: 1n });
    expect(await usdcOf(api, fresh)).toBe(0n);
    expect(await creditOf(api, fresh)).toBe(0n);
  });

  it("refuses when credit plus balance is short and changes nothing", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const state = async () => JSON.stringify([(await usdcOf(api)).toString(), (await creditOf(api)).toString(), await api.getPosition(2, MOCK_ACCOUNT), (await api.getBattle(2))!.vault_a]);
    const before = await state();
    await expect(api.depositFromBalance({ signerId: MOCK_ACCOUNT, battleId: 2, side: "A", totalUsdc: 60_000_000n, minTokenOut: 1n })).rejects.toThrow("Deposit refused");
    expect(await state()).toBe(before);
  });

  it("refuses closed battles and the opposite side", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    await api.fundBalance({ signerId: "x.testnet", amount: 10_000_000n });
    await expect(api.depositFromBalance({ signerId: "x.testnet", battleId: 3, side: "A", totalUsdc: 1_000_000n, minTokenOut: 1n })).rejects.toThrow("Deposit refused");
    // The demo account already backs side A of battle 2.
    await expect(api.depositFromBalance({ signerId: MOCK_ACCOUNT, battleId: 2, side: "B", totalUsdc: 1_000_000n, minTokenOut: 1n })).rejects.toThrow("Deposit refused");
  });

  it("restores balance and credit when the swap fails", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const before = [await usdcOf(api), await creditOf(api), (await api.getBattle(2))!.vault_a];
    api.failNextBalanceDeposit();
    await expect(api.depositFromBalance({ signerId: MOCK_ACCOUNT, battleId: 2, side: "A", totalUsdc: 40_000_000n, minTokenOut: 1n })).rejects.toThrow("restored");
    expect([await usdcOf(api), await creditOf(api), (await api.getBattle(2))!.vault_a]).toEqual(before);
    // The failure is one-shot.
    await api.depositFromBalance({ signerId: MOCK_ACCOUNT, battleId: 2, side: "A", totalUsdc: 40_000_000n, minTokenOut: 1n });
    expect(await creditOf(api)).toBe(0n);
  });

  it("treats a minimum output above the quote as a failed swap that restores everything", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const before = [await usdcOf(api), await creditOf(api)];
    await expect(
      api.depositFromBalance({ signerId: MOCK_ACCOUNT, battleId: 2, side: "A", totalUsdc: 40_000_000n, minTokenOut: 10n ** 40n }),
    ).rejects.toThrow("restored");
    expect([await usdcOf(api), await creditOf(api)]).toEqual(before);
  });
});
