import { describe, expect, it } from "vitest";
import { resolveAssetRefs, type AssetSearch, type RegistryAsset } from "./lifecycle-resolve";

const asset = (token: string, label: string | null, ref: string | null): RegistryAsset => ({
  chainId: "46630",
  token,
  referenceChainId: "4663",
  referenceToken: "0x" + "9".repeat(40),
  assetKey: `46630:${token}`,
  registryVersion: "1",
  label: label ? { symbol: `m${label}`, name: `Mock ${label}`, kind: "testnet-mock" } : null,
  referenceLabel: ref ? { symbol: ref, name: ref, kind: "mainnet-reference" } : null,
});
const CASHCAT = asset("0x" + "1".repeat(40), "CASHCAT", "CASHCAT");
const WALLET = asset("0x" + "2".repeat(40), "WALLET", "WALLET");
const GOODA = asset("0x" + "3".repeat(40), "GOOD", "GOOD");
const GOODB = asset("0x" + "4".repeat(40), "GOODISH", "GOOD");
const REGISTRY = [CASHCAT, WALLET, GOODA, GOODB];

/** A backend search: substring over the asset key, the symbols and the names, as the agent does. */
const search: AssetSearch = async (q) =>
  REGISTRY.filter((a) =>
    [a.assetKey, a.referenceToken, a.label?.symbol, a.label?.name, a.referenceLabel?.symbol, a.referenceLabel?.name]
      .some((v) => v?.toLowerCase().includes(q.toLowerCase())),
  );

describe("resolving token names through the registry", () => {
  it("resolves a symbol, a $symbol, the mock symbol and the mock name case-insensitively", async () => {
    for (const ref of ["CASHCAT", "cashcat", "$CashCat", "mCASHCAT", "Mock CASHCAT"]) {
      const r = await resolveAssetRefs([ref, "wallet"], search);
      expect(r.ok, ref).toBe(true);
      if (r.ok) {
        expect(r.assets[0]!.asset.token).toBe(CASHCAT.token);
        expect(r.assets[1]!.asset.token).toBe(WALLET.token);
      }
    }
  });
  it("takes the address from the registry entry, never from the text", async () => {
    const r = await resolveAssetRefs(["cashcat", "wallet"], search);
    expect(r.ok && r.assets.map((a) => a.asset.token)).toEqual([CASHCAT.token, WALLET.token]);
  });
  it("asks which one when a name matches more than one registry asset", async () => {
    const r = await resolveAssetRefs(["good", "wallet"], search);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.ref).toBe("good");
      expect(r.question).toMatch(/matches 2 registry assets/);
      expect(r.question).toMatch(/0x address/);
    }
  });
  it("asks about an unknown name instead of inventing an asset", async () => {
    const r = await resolveAssetRefs(["pepe", "wallet"], search);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.question).toMatch(/could not find "pepe"/);
  });
  it("does not accept a partial name or a different token that only contains the text", async () => {
    // "cash" is a substring of the label, but only an exact symbol or name resolves.
    const r = await resolveAssetRefs(["cash", "wallet"], search);
    expect(r.ok).toBe(false);
  });
  it("rejects two names for the same token and keeps addresses working", async () => {
    const dup = await resolveAssetRefs(["cashcat", "mCASHCAT"], search);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.question).toMatch(/already listed/);
    const mixed = await resolveAssetRefs([`46630:${CASHCAT.token}`, "wallet"], search);
    expect(mixed.ok).toBe(true);
  });
  it("reports a search outage as a retry message", async () => {
    const r = await resolveAssetRefs(["cashcat", "wallet"], async () => {
      throw new Error("offline");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.question).toMatch(/could not be searched/);
  });
  it("still rejects free text that is neither a name nor an address", async () => {
    const r = await resolveAssetRefs(["drop table; --", "wallet"], search);
    expect(r.ok).toBe(false);
  });
});
