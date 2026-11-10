import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_TOKEN_LABELS, labelFor, labelMatches } from "../src/token-labels.js";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

describe("token labels", () => {
  it("labels every testnet mock exactly as the deploy evidence read it back from the contracts", () => {
    const evidence = read("../../docs/evidence/2026-11-09-evm-testnet-deploy.json");
    expect(evidence.mockTokens.length).toBeGreaterThan(0);
    for (const t of evidence.mockTokens) {
      expect(labelFor("46630", t.address)).toEqual({ symbol: t.symbol, name: t.name, kind: "testnet-mock" });
      expect(labelFor(46630, t.address.toLowerCase())?.symbol).toBe(t.symbol);
    }
  });
  it("labels every registry-matched mascot's mainnet reference token", () => {
    const { characters } = read("../../web/src/components/colosseum/characters.json");
    for (const c of characters.filter((x: { referenceAddress?: string }) => x.referenceAddress)) {
      expect(labelFor(String(c.referenceChainId), c.referenceAddress)).toMatchObject({ symbol: c.name, kind: "mainnet-reference" });
    }
  });
  it("has no duplicate keys and only well-formed ones", () => {
    const keys = ALL_TOKEN_LABELS.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[0-9]+:0x[0-9a-f]{40}$/);
  });
  it("does not label an unknown token, the wrong chain or malformed input", () => {
    const evidence = read("../../docs/evidence/2026-11-09-evm-testnet-deploy.json");
    expect(labelFor("46630", "0x" + "11".repeat(20))).toBeNull();
    expect(labelFor("1", evidence.mockTokens[0].address)).toBeNull();
    expect(labelFor("46630", "not-an-address")).toBeNull();
    expect(labelFor("abc", evidence.mockTokens[0].address)).toBeNull();
  });
  it("matches a query against symbol or name, case-insensitively by caller contract", () => {
    const label = labelFor("46630", read("../../docs/evidence/2026-11-09-evm-testnet-deploy.json").mockTokens[0].address);
    expect(labelMatches(label, "cashcat")).toBe(true);
    expect(labelMatches(label, "mock")).toBe(true);
    expect(labelMatches(label, "pepe")).toBe(false);
    expect(labelMatches(null, "cashcat")).toBe(false);
    expect(labelMatches(label, "")).toBe(false);
  });
});
