import { describe, expect, it } from "vitest";
import type { ApplicationBattleSummary } from "@/lib/arena-read/application";
import { chooseArena, communityForToken, matchesToken, openArenasOf } from "./lifecycle-open";

const NOW = 1_800_000_000_000;
const community = (index: number, symbol: string | null) => ({
  index, funded: true, representation: `backing-${(symbol ?? "x").toLowerCase()}.testnet`, tokenAddress: `0x${index}`, chainId: "46630",
  label: symbol ? { symbol, name: `Mock ${symbol}`, kind: "testnet-mock" as const } : null,
});
const battle = (id: number, over: Partial<ApplicationBattleSummary> = {}): ApplicationBattleSummary => ({
  battleId: String(id), creator: "c.testnet", mode: "PriceGain", status: "open", winner: null, startAtMs: String(NOW + id * 60_000),
  cancelled: false, enteredCount: 1, pendingCount: 0, communities: [community(0, "CASHCAT")], ...over,
});

describe("open arenas", () => {
  it("keeps only arenas that still accept communities, soonest start first", () => {
    const list = openArenasOf(
      [
        battle(3), battle(1),
        battle(4, { status: "locked" }), battle(5, { cancelled: true }), battle(6, { startAtMs: null }),
        battle(7, { startAtMs: String(NOW - 1) }), battle(8, { startAtMs: "abc" }), battle(0),
      ],
      NOW,
    );
    expect(list.map((a) => a.battleId)).toEqual([1, 3]);
  });
});

describe("token matching", () => {
  const c = community(0, "CASHCAT");
  it.each(["cashcat", "$CASHCAT", " Mock CASHCAT ", "backing-cashcat.testnet"])("matches %s", (ref) => expect(matchesToken(ref, c)).toBe(true));
  it.each(["wallet", "cash", "", "backing-wallet.testnet", "m"])("does not match %s", (ref) => expect(matchesToken(ref, c)).toBe(false));
  it("matches a testnet mock labelled mCASHCAT / Mock CASHCAT by the plain name people use", () => {
    const mock = { representation: "backing-cashcat.testnet", label: { symbol: "mCASHCAT", name: "Mock CASHCAT", kind: "testnet-mock" } };
    for (const ref of ["CASHCAT", "cashcat", "mCASHCAT", "Mock CASHCAT", "$cashcat"]) expect(matchesToken(ref, mock)).toBe(true);
    expect(matchesToken("wallet", mock)).toBe(false);
    // A real token whose symbol merely starts with m keeps its own name only.
    const real = { representation: "backing-mog.testnet", label: { symbol: "MOG", name: "Mog Coin", kind: "mainnet-reference" } };
    expect(matchesToken("og", real)).toBe(false);
    expect(matchesToken("mog", real)).toBe(true);
  });
  it("never matches an unlabeled community by a name", () => expect(matchesToken("x", { representation: "backing-y.testnet", label: null })).toBe(false));
});

describe("choosing an arena", () => {
  const join = { kind: "join_battle", battleId: null, tokenRef: "CASHCAT" } as const;
  const dep = (tokenRef: string | null) => ({ kind: "deposit", battleId: null, community: tokenRef ? null : 0, tokenRef, amount: "1" }) as const;

  it("says so when no arena is open", () => {
    expect(chooseArena(join, [])).toMatchObject({ kind: "none" });
  });
  it("uses the only open arena and says why", () => {
    const [a] = openArenasOf([battle(1)], NOW);
    expect(chooseArena(join, [a!])).toMatchObject({ kind: "one", why: "the only open arena" });
  });
  it("never picks among several: it returns them all for the user to choose", () => {
    const arenas = openArenasOf([battle(1), battle(2), battle(3)], NOW);
    const r = chooseArena(join, arenas);
    expect(r.kind).toBe("many");
    if (r.kind === "many") expect(r.arenas.map((a) => a.battleId)).toEqual([1, 2, 3]);
  });
  it("a deposit by token only considers arenas that already have that token", () => {
    const arenas = openArenasOf([battle(1, { communities: [community(0, "WALLET")] }), battle(2), battle(3, { communities: [community(0, "CASHCAT"), community(1, "WALLET")] })], NOW);
    const r = chooseArena(dep("cashcat"), arenas);
    expect(r.kind).toBe("many");
    if (r.kind === "many") expect(r.arenas.map((a) => a.battleId)).toEqual([2, 3]);
    expect(chooseArena(dep("wallet"), arenas)).toMatchObject({ kind: "many" });
    const single = chooseArena(dep("wallet"), openArenasOf([battle(1, { communities: [community(0, "WALLET")] }), battle(2)], NOW));
    expect(single).toMatchObject({ kind: "one" });
  });
  it("offers to join first when no open arena has the token", () => {
    const arenas = openArenasOf([battle(1), battle(2)], NOW);
    const r = chooseArena(dep("good"), arenas);
    expect(r.kind).toBe("none");
    if (r.kind === "none") {
      expect(r.message).toMatch(/Join one with good first/);
      expect(r.joinable.map((a) => a.battleId)).toEqual([1, 2]);
    }
  });
  it("a deposit by community number does not filter by token", () => {
    const arenas = openArenasOf([battle(1), battle(2)], NOW);
    expect(chooseArena(dep(null), arenas)).toMatchObject({ kind: "many" });
  });
});

describe("community of a token", () => {
  const cs = [community(0, "CASHCAT"), community(1, "WALLET")];
  it("finds exactly one, none, or lists several", () => {
    expect(communityForToken("wallet", cs)).toEqual({ kind: "one", index: 1 });
    expect(communityForToken("good", cs)).toEqual({ kind: "none" });
    expect(communityForToken("cashcat", [...cs, community(2, "CASHCAT")])).toEqual({ kind: "many", indexes: [0, 2] });
  });
});
