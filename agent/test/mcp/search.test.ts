import { describe, expect, it } from "vitest";
import { FixtureArenaReadSource } from "../../src/mcp/read-source.js";
import { MAX_SCAN, SearchValidationError, parseSearchParams, searchBattles } from "../../src/mcp/search.js";
import { battle, makeSource } from "./fixtures.js";

describe("backend battle search", () => {
  it("validates parameters and rejects unknown or oversized input", () => {
    expect(parseSearchParams({ q: "  PePe ", mode: "PriceGain", status: "open", limit: "5", cursor: "9" })).toEqual({
      q: "pepe", mode: "PriceGain", status: "open", limit: 5, cursor: "9",
    });
    expect(parseSearchParams({ q: "", mode: "" })).toEqual({});
    for (const bad of [{ q: "x".repeat(65) }, { mode: "Fastest" }, { status: "won" }, { limit: "0" }, { limit: "51" },
      { cursor: "-1" }, { cursor: "abc" }, { community: "UPPER!" }, { sql: "1" }, { q: { $ne: 1 } }]) {
      expect(() => parseSearchParams(bad as Record<string, unknown>)).toThrow(SearchValidationError);
    }
  });

  it("filters by text, mode, status and community on the server, newest first", async () => {
    const src = makeSource();
    const ids = async (p: Record<string, unknown>) => (await searchBattles(src, parseSearchParams(p))).items.map((b) => b.battleId);
    expect(await ids({})).toEqual([3, 2, 1]);
    expect(await ids({ q: "whale" })).toEqual([3]);
    expect(await ids({ q: "2" })).toEqual([2]);
    expect(await ids({ mode: "LowestDrawdown" })).toEqual([2]);
    expect(await ids({ status: "open" })).toEqual([1]);
    expect(await ids({ status: "locked" })).toEqual([3]);
    expect(await ids({ status: "decided" })).toEqual([2]);
    expect(await ids({ community: "doge.rep.testnet" })).toEqual([3, 2, 1]);
    expect(await ids({ community: "nobody.testnet" })).toEqual([]);
  });

  it("pages with a cursor and stops at the scan cap", async () => {
    const src = makeSource();
    const first = await searchBattles(src, { limit: 2 });
    expect(first.items.map((b) => b.battleId)).toEqual([3, 2]);
    expect(first.nextCursor).toBe("1");
    const second = await searchBattles(src, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((b) => b.battleId)).toEqual([1]);
    expect(second.nextCursor).toBeNull();

    const many = new FixtureArenaReadSource("near-testnet", {
      battles: new Map(Array.from({ length: MAX_SCAN + 50 }, (_, i) => [i + 1, battle({ creator: "a.testnet" })])),
    });
    const capped = await searchBattles(many, { q: "nomatch" });
    expect(capped).toMatchObject({ items: [], truncated: true, nextCursor: String(MAX_SCAN + 50 - MAX_SCAN) });
  });
});
