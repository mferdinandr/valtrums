import { describe, expect, it } from "vitest";
import { fetchAllBattles } from "../src/client.js";
import { FakeArenaClient, makeBattle } from "../src/fake-client.js";

describe("FakeArenaClient", () => {
  it("pages through all battles in ascending id order", async () => {
    const client = new FakeArenaClient(
      [3, 1, 2, 0, 4].map((id) => makeBattle({ id })),
    );
    const all = await fetchAllBattles(client, 2);
    expect(all.map((b) => b.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it("rejects a second approve like the contract would", async () => {
    const client = new FakeArenaClient([makeBattle({ id: 0 })]);
    await client.approveBattle(0);
    await expect(client.approveBattle(0)).rejects.toThrow(/status Approved/);
  });
});
