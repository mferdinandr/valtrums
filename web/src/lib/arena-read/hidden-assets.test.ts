import { describe, expect, it } from "vitest";
import { isHiddenAsset, isHiddenSymbol } from "./hidden-assets";
import { CONTENDERS } from "@/components/colosseum/choreography";

describe("hidden assets (AI left the allowlist, D35)", () => {
  it("hides AI by its mainnet reference or testnet mock address, in any case", () => {
    expect(isHiddenAsset({ token: "0x973C4E0601C03A4899B8C9643B299AAAECE4BA0A", referenceToken: null })).toBe(true);
    expect(isHiddenAsset({ token: "0x1111111111111111111111111111111111111111", referenceToken: "0x0d4a117dccce7ba3d0a475ec9068c20c35310fd8" })).toBe(true);
    expect(isHiddenAsset({ token: "0x5b2ba17e5be1b611c1299809db89c5fe21d9d0a6", referenceToken: "0x020bfc650a365f8bb26819deaabf3e21291018b4" })).toBe(false);
  });
  it("hides the faucet's AI entry by symbol only for AI itself", () => {
    expect(isHiddenSymbol("AI")).toBe(true);
    expect(isHiddenSymbol("mAI")).toBe(true);
    expect(isHiddenSymbol("CASHCAT")).toBe(false);
    expect(isHiddenSymbol("MAIN")).toBe(false);
  });
  it("leaves AI out of the mascot roster used by the landing page and the arena", () => {
    expect(CONTENDERS.map((c) => c.name)).not.toContain("AI");
    expect(CONTENDERS.map((c) => c.name)).toEqual(["CASHCAT", "WALLET", "GOOD", "VLAD", "DEGEN"]);
  });
});
