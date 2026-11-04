import { describe, expect, it } from "vitest";
import { createMockArenaApi, MOCK_ACCOUNT } from "./mock";
import { previewWinnerPayout, priceBasis, vaultsInUsdc } from "./payout";

const T0 = 1_800_000_000_000;

describe("mock arena api", () => {
  it("is deterministic for a fixed clock", async () => {
    const a = createMockArenaApi({ now: () => T0 });
    const b = createMockArenaApi({ now: () => T0 });
    expect(await a.getBattles(0, 50)).toEqual(await b.getBattles(0, 50));
    expect(await a.getLivePrices(3)).toEqual(await b.getLivePrices(3));
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

  it("claim matches the payout preview", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const b = (await api.getBattle(5))!;
    const pos = (await api.getPosition(5, MOCK_ACCOUNT))!;
    const prices = priceBasis(b, null)!;
    const vaults = vaultsInUsdc(b, await api.getTokenMeta(b.token_a), await api.getTokenMeta(b.token_b), prices);
    const preview = previewWinnerPayout(pos, vaults);
    const before = await api.getAccount(MOCK_ACCOUNT);
    await api.claim({ signerId: MOCK_ACCOUNT, battleId: 5 });
    const after = await api.getAccount(MOCK_ACCOUNT);
    expect(BigInt(after.liquid_balance) - BigInt(before.liquid_balance)).toBe(preview.totalLiquid);
    expect(BigInt(after.credit_balance) - BigInt(before.credit_balance)).toBe(preview.credit);
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
