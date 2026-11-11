// FIXTURE-ONLY: a fake RPC. Nothing here touches a chain.
import { describe, expect, it } from "vitest";
import { readCommunityState, readRegistered } from "./join-deposit";

const view = (value: unknown) => async () =>
  new Response(JSON.stringify({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } }), { status: 200 });

describe("readCommunityState", () => {
  const battle = { communities: [
    { representation: "a.testnet", audit_evidence_hash: "x", backing_evidence_hash: "y" },
    { representation: "b.testnet", audit_evidence_hash: "x", backing_evidence_hash: null },
  ] };
  it("finds the community and whether both approvals exist", async () => {
    expect(await readCommunityState("https://rpc", "arena.testnet", 1, "a.testnet", view(battle))).toEqual({ index: 0, approved: true });
    expect(await readCommunityState("https://rpc", "arena.testnet", 1, "b.testnet", view(battle))).toEqual({ index: 1, approved: false });
  });
  it("reports a token that is not in the battle yet", async () => {
    expect(await readCommunityState("https://rpc", "arena.testnet", 1, "c.testnet", view(battle))).toEqual({ index: null, approved: false });
    expect(await readCommunityState("https://rpc", "arena.testnet", 1, "c.testnet", view(null))).toEqual({ index: null, approved: false });
  });
});

describe("readRegistered", () => {
  it("reads whether the account registered a position", async () => {
    expect(await readRegistered("https://rpc", "arena.testnet", 1, 0, "alice.testnet", view({ registered: true, amount: "0" }))).toBe(true);
    expect(await readRegistered("https://rpc", "arena.testnet", 1, 0, "alice.testnet", view({ registered: false, amount: "0" }))).toBe(false);
  });
});
