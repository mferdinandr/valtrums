import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOGO_IDS, logoSrc, logoUpstream } from "../token-logos";
import { accentFor, displaySymbol, monogram } from "./token-style";

describe("displaySymbol", () => {
  it("drops the mock prefix of a testnet mock and keeps every other symbol", () => {
    expect(displaySymbol({ symbol: "mDEGEN", kind: "testnet-mock" }, "x")).toBe("DEGEN");
    expect(displaySymbol({ symbol: "mAI", kind: "testnet-mock" }, "x")).toBe("AI");
    expect(displaySymbol({ symbol: "CASHCAT", kind: "mainnet-reference" }, "x")).toBe("CASHCAT");
    // A real symbol that merely starts with a lowercase m is not stripped.
    expect(displaySymbol({ symbol: "meme", kind: "testnet-mock" }, "x")).toBe("meme");
  });
  it("falls back when there is no label", () => {
    expect(displaySymbol(null, "0x1234")).toBe("0x1234");
    expect(displaySymbol(undefined, "0x1234")).toBe("0x1234");
  });
});

describe("accentFor and monogram", () => {
  it("uses the curated accent for known tokens and a stable derived one otherwise", () => {
    expect(accentFor("degen")).toBe("#f2b01e");
    expect(accentFor("PEPE")).toBe(accentFor("PEPE"));
    expect(accentFor("PEPE")).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("makes a short monogram and never an empty one", () => {
    expect(monogram("DEGEN")).toBe("DE");
    expect(monogram("$a")).toBe("A");
    expect(monogram("")).toBe("?");
  });
});

describe("token logos", () => {
  it("serves only through our own route and builds the upstream url only from the fixed table", () => {
    expect(logoSrc("DEGEN")).toBe("/api/token-logo/degen");
    expect(logoSrc("unknown")).toBeNull();
    expect(logoSrc("__proto__")).toBeNull();
    expect(logoSrc("constructor")).toBeNull();
    expect(logoUpstream("degen")).toBe(`https://cdn.dexscreener.com/cms/images/${LOGO_IDS.degen}?width=128&height=128&quality=90&format=auto`);
    expect(logoUpstream("../../etc/passwd")).toBeNull();
    expect(logoUpstream("toString")).toBeNull();
  });
  it("has a logo only for tokens that are registry-matched mascots", () => {
    const { characters } = JSON.parse(readFileSync(new URL("../../components/colosseum/characters.json", import.meta.url), "utf8"));
    const names = new Set(characters.map((c: { name: string }) => c.name.toLowerCase()));
    for (const key of Object.keys(LOGO_IDS)) expect(names.has(key), key).toBe(true);
  });
});
