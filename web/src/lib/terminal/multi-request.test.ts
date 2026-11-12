import { describe, expect, it } from "vitest";
import { parseRequests, splitRequests } from "./multi-request";
import { createLifecycleRouteParser } from "./lifecycle-parse-client";
import { loadPlans, removePlan, savePlan } from "./saved-plans";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("several requests in one prompt", () => {
  const PROMPT = "deposit 2 CASHCAT dan 2 VLAD di 1 arena yang sedang open, lalu vote burn 50% di battle tersebut kalau menang";

  it("splits the example into three requests and lets a bare amount repeat the deposit verb", () => {
    expect(splitRequests(PROMPT)).toEqual([
      "deposit 2 CASHCAT",
      "deposit 2 VLAD di 1 arena yang sedang open",
      "vote burn 50% di battle tersebut",
    ]);
  });
  it("reads them as two deposits by token and a vote on the same battle", async () => {
    const r = await parseRequests(PROMPT);
    expect(r).toMatchObject({ ok: true });
    if (!r || !r.ok) throw new Error("not ok");
    expect(r.intents).toEqual([
      { kind: "deposit", battleId: null, community: null, tokenRef: "CASHCAT".toLowerCase(), amount: "2000000000000000000" },
      { kind: "deposit", battleId: null, community: null, tokenRef: "vlad", amount: "2000000000000000000" },
      { kind: "dao_vote", battleId: null, burnPercent: 50 },
    ]);
  });
  it("is null for a single request, so it is read as before", async () => {
    expect(await parseRequests("deposit 2 CASHCAT ke arena yang open dong")).toBeNull();
  });
  it("falls back to one request when a part cannot be read", async () => {
    expect(await parseRequests("buat battle price gain dan mulai dalam 15 menit")).toBeNull();
  });
  it("refuses more than four requests and unsupported combinations instead of dropping some", async () => {
    const five = "deposit 1 CASHCAT, deposit 1 VLAD, deposit 1 GOOD, deposit 1 WALLET, deposit 1 DEGEN";
    expect(await parseRequests(five)).toMatchObject({ ok: false });
    expect(await parseRequests("deposit 1 CASHCAT and cancel battle 7")).toMatchObject({ ok: false });
  });
});

describe("through the browser parser", () => {
  it("answers the full prompt with three requests and never calls the server route", async () => {
    let called = false;
    const parser = createLifecycleRouteParser((async () => { called = true; throw new Error("no network"); }) as unknown as typeof fetch);
    for (const prompt of [
      "deposit 2 CASHCAT dan 2 VLAD di 1 arena yang sedang open, lalu vote burn 50% di battle tersebut kalau menang",
      "Deposit 2 CASHCAT and 2 VLAD in one open arena, then vote burn 50% on that battle if I win",
    ]) {
      const r = await parser.parse(prompt);
      expect(r).toMatchObject({ ok: true });
      if (!r.ok) throw new Error(r.error);
      expect(r.intents?.map((i) => i.kind)).toEqual(["deposit", "deposit", "dao_vote"]);
    }
    expect(called).toBe(false);
  });
});

describe("saved vote plans", () => {
  it("saves once per account and battle, lists and removes", () => {
    const store = memory();
    savePlan(store, { account: "a.testnet", battleId: 7, burnPercent: 50 }, 1);
    savePlan(store, { account: "a.testnet", battleId: 7, burnPercent: 10 }, 2);
    savePlan(store, { account: "b.testnet", battleId: 7, burnPercent: 0 }, 3);
    expect(loadPlans(store)).toHaveLength(2);
    expect(loadPlans(store)[0]).toMatchObject({ battleId: 7, burnPercent: 50 });
    expect(removePlan(store, "a.testnet:7")).toHaveLength(1);
  });
  it("ignores broken storage and invalid entries", () => {
    const store = memory();
    store.setItem("valtrum:terminal:plans", JSON.stringify([{ id: "x", account: "a", battleId: 0, burnPercent: 5, createdAt: 1 }, "junk"]));
    expect(loadPlans(store)).toEqual([]);
    store.setItem("valtrum:terminal:plans", "{not json");
    expect(loadPlans(store)).toEqual([]);
    expect(loadPlans(null)).toEqual([]);
  });
});
