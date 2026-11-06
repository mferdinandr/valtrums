import { describe, expect, it } from "vitest";
import { RevenuePolicyRegistry, allocateLosingVaults } from "../src/arena-revenue.js";

const treasury = "0x1111111111111111111111111111111111111111";
const creatorWallet = "0x2222222222222222222222222222222222222222";
const newWallet = "0x3333333333333333333333333333333333333333";
const winners = [{ accountId: "alice.testnet", units: 60n }, { accountId: "bob.testnet", units: 40n }];
function setup() {
  const registry = new RevenuePolicyRegistry("protocol.testnet", treasury);
  registry.bindRecipient("creator.testnet", creatorWallet);
  registry.bindRecipient("protocol.testnet", treasury);
  return registry;
}
function allocation(registry = setup(), units = 100000n, protocol = false) {
  const snapshot = registry.snapshotAtCreation(protocol ? "protocol.testnet" : "creator.testnet", protocol);
  return allocateLosingVaults(snapshot, [{ assetId: "46630:coin-b", units }], winners)[0]!;
}

describe("creation-time revenue policy", () => {
  it("uses defaults and returns versioned update evidence", () => {
    const registry = setup();
    expect(registry.policy).toEqual({ version: 1n, totalFeeBps: 10, creatorShareBps: 5000 });
    const event = registry.update("protocol.testnet", 200, 2500);
    expect(event).toEqual({ actor: "protocol.testnet", previous: { version: 1n, totalFeeBps: 10, creatorShareBps: 5000 }, current: { version: 2n, totalFeeBps: 200, creatorShareBps: 2500 } });
    expect(Object.isFrozen(event.previous)).toBe(true);
  });
  it("preserves the creation snapshot through gathering, overtime and recipient rebinding", () => {
    const registry = setup();
    const old = registry.snapshotAtCreation("creator.testnet", false);
    registry.update("protocol.testnet", 200, 2500);
    registry.bindRecipient("creator.testnet", newWallet);
    registry.setProtocolCreator("protocol.testnet", "creator.testnet", true);
    const fresh = registry.snapshotAtCreation("creator.testnet", true);
    expect(old).toEqual({ version: 1n, totalFeeBps: 10, creatorShareBps: 5000, creator: "creator.testnet", protocolCreated: false, creatorRecipient: creatorWallet, protocolRecipient: treasury });
    expect(fresh).toMatchObject({ version: 2n, totalFeeBps: 200, protocolCreated: true, creatorRecipient: newWallet });
    expect(Object.isFrozen(old)).toBe(true);
    expect(allocateLosingVaults(old, [{ assetId: "b", units: 100000n }], winners)[0]!.creatorFeeUnits).toBe(50n);
  });
  it("rejects unauthorized changes without changing state", () => {
    const registry = setup(); const before = registry.policy;
    expect(() => registry.update("attacker.testnet", 10000, 10000)).toThrow("authority");
    expect(() => registry.setProtocolCreator("attacker.testnet", "attacker.testnet", true)).toThrow("authority");
    expect(registry.policy).toBe(before);
  });
  it.each([-1, 10001, 0.5, NaN, Infinity])("rejects invalid bps %s without advancing version", (invalid) => {
    const registry = setup(); const before = registry.policy;
    expect(() => registry.update("protocol.testnet", invalid, 5000)).toThrow();
    expect(() => registry.update("protocol.testnet", 10, invalid)).toThrow();
    expect(registry.policy).toBe(before);
  });
  it("refuses creator spoofing, unbound recipients and noncanonical identities", () => {
    const registry = setup();
    expect(() => registry.snapshotAtCreation("creator.testnet", true)).toThrow("identity mismatch");
    expect(() => registry.snapshotAtCreation("protocol.testnet", false)).toThrow("identity mismatch");
    expect(() => registry.snapshotAtCreation("stranger.testnet", false)).toThrow("binding missing");
    expect(() => registry.bindRecipient("Alice.testnet", creatorWallet)).toThrow("canonical");
    expect(() => registry.bindRecipient("creator.testnet", "0x" + "0".repeat(40))).toThrow("nonzero");
  });
});

describe("per-token allocation", () => {
  it("matches the default two-community example", () => {
    expect(allocation()).toMatchObject({ vaultUnits: 100000n, feeUnits: 100n, creatorFeeUnits: 50n, protocolFeeUnits: 50n, winnerPoolUnits: 99900n, rewards: [{ accountId: "alice.testnet", units: 59940n }, { accountId: "bob.testnet", units: 39960n }] });
  });
  it("collects total fee first and assigns an odd fee unit to protocol", () => {
    expect(allocation(setup(), 1000n)).toMatchObject({ feeUnits: 1n, creatorFeeUnits: 0n, protocolFeeUnits: 1n, winnerPoolUnits: 999n });
    expect(allocation(setup(), 999n)).toMatchObject({ feeUnits: 0n, winnerPoolUnits: 999n });
    expect(allocation(setup(), 10003n)).toMatchObject({ feeUnits: 10n, creatorFeeUnits: 5n, protocolFeeUnits: 5n, winnerPoolUnits: 9993n });
  });
  it("uses a 2% fee and 25% creator split", () => {
    const registry = setup(); registry.update("protocol.testnet", 200, 2500);
    expect(allocation(registry)).toMatchObject({ winnerPoolUnits: 98000n, creatorFeeUnits: 500n, protocolFeeUnits: 1500n });
    expect(allocation(registry, 100000n, true)).toMatchObject({ creatorFeeUnits: 0n, protocolFeeUnits: 2000n });
  });
  it("gives protocol-created battles the full fee regardless of configured ratio", () => {
    const registry = setup(); registry.update("protocol.testnet", 10, 10000);
    expect(allocation(registry, 1000n, true)).toMatchObject({ creatorFeeUnits: 0n, protocolFeeUnits: 1n });
  });
  it.each([0, 10000])("accepts total fee boundary %s with either creator split boundary", (fee) => {
    for (const share of [0, 10000]) {
      const registry = setup(); registry.update("protocol.testnet", fee, share);
      const result = allocation(registry);
      expect(result.winnerPoolUnits).toBe(fee === 0 ? 100000n : 0n);
      expect(result.creatorFeeUnits).toBe(share === 10000 ? result.feeUnits : 0n);
      expect(result.winnerPoolUnits + result.creatorFeeUnits + result.protocolFeeUnits).toBe(100000n);
    }
  });
  it("preserves different asset units separately", () => {
    const registry = setup(); const snapshot = registry.snapshotAtCreation("creator.testnet", false);
    const results = allocateLosingVaults(snapshot, [{ assetId: "46630:b", units: 100000n }, { assetId: "46630:c", units: 200000n }], winners);
    expect(results.map(x => [x.assetId, x.winnerPoolUnits])).toEqual([["46630:b", 99900n], ["46630:c", 199800n]]);
    expect(() => allocateLosingVaults(snapshot, [{ assetId: "b", units: 1n }, { assetId: "b", units: 1n }], winners)).toThrow("duplicate");
  });
  it("aggregates duplicate beneficiary weights before dust and ignores input ordering", () => {
    const registry = setup(); const snapshot = registry.snapshotAtCreation("creator.testnet", false);
    const positions = [ { accountId: "carol.testnet", units: 3n }, { accountId: "alice.testnet", units: 1n }, { accountId: "bob.testnet", units: 1n }, { accountId: "bob.testnet", units: 1n } ];
    const original = positions.map(x => ({ ...x }));
    const vaults = [{ assetId: "b", units: 10003n }];
    const result = allocateLosingVaults(snapshot, vaults, positions)[0]!;
    expect(result.rewards).toEqual([{ accountId: "alice.testnet", units: 1666n }, { accountId: "bob.testnet", units: 3331n }, { accountId: "carol.testnet", units: 4996n }]);
    expect(allocateLosingVaults(snapshot, vaults, [...positions].reverse())[0]).toEqual(result);
    expect(positions).toEqual(original);
    expect(Object.isFrozen(result.rewards)).toBe(true);
    expect(Object.isFrozen(result.rewards[0])).toBe(true);
  });
  it("uses canonical byte order rather than claim order for equal dust", () => {
    const snapshot = setup().snapshotAtCreation("creator.testnet", false);
    const result = allocateLosingVaults(snapshot, [{ assetId: "b", units: 1n }], [{ accountId: "zeta.testnet", units: 1n }, { accountId: "alice.testnet", units: 1n }])[0]!;
    expect(result.rewards).toEqual([{ accountId: "alice.testnet", units: 1n }, { accountId: "zeta.testnet", units: 0n }]);
  });
  it("conserves every token unit over small vaults, unusual ratios and u128 limits", () => {
    const registry = setup();
    for (const fee of [0, 1, 10, 3333, 10000]) for (const share of [0, 1, 5000, 9999, 10000]) {
      registry.update("protocol.testnet", fee, share);
      const snapshot = registry.snapshotAtCreation("creator.testnet", false);
      for (const amount of [0n, 1n, 7n, 999n, 1000n, 10003n, (1n << 128n) - 1n]) {
        const result = allocateLosingVaults(snapshot, [{ assetId: "b", units: amount }], [{ accountId: "alice.testnet", units: 1n }, { accountId: "bob.testnet", units: 2n }, { accountId: "carol.testnet", units: 3n }])[0]!;
        expect(result.rewards.reduce((s, r) => s + r.units, 0n) + result.creatorFeeUnits + result.protocolFeeUnits).toBe(amount);
        expect(result.feeUnits * 1000n).toBeLessThanOrEqual(amount * BigInt(fee) / 10n);
      }
    }
  });
  it("refuses impossible amounts and zero/invalid winner positions", () => {
    const snapshot = setup().snapshotAtCreation("creator.testnet", false);
    expect(() => allocateLosingVaults(snapshot, [{ assetId: "b", units: -1n }], winners)).toThrow("u128");
    expect(() => allocateLosingVaults(snapshot, [{ assetId: "b", units: 1n << 128n }], winners)).toThrow("u128");
    expect(() => allocateLosingVaults(snapshot, [{ assetId: "b", units: 1n }], [])).toThrow("nonempty");
    expect(() => allocateLosingVaults(snapshot, [{ assetId: "b", units: 1n }], [{ accountId: "alice.testnet", units: 0n }])).toThrow("positive");
    expect(() => allocateLosingVaults(snapshot, [{ assetId: "b", units: 1n }], [{ accountId: "alice.testnet", units: (1n << 128n) - 1n }, { accountId: "bob.testnet", units: 1n }])).toThrow("u128");
  });
});
