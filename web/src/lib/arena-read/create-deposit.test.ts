// FIXTURE-ONLY: a fake RPC. Nothing here touches a chain.
import { describe, expect, it } from "vitest";
import { firstDepositProblems, parseCreatedBattleId, readCommunityIndex, readCommunityReadiness, readCreatedBattleId } from "./create-deposit";

const created = (battleId: number, creator: string) =>
  `EVENT_JSON:${JSON.stringify({ standard: "valtrum", version: "1", event: "lifecycle_battle_created", data: [{ battle_id: battleId, creator }] })}`;

describe("parseCreatedBattleId", () => {
  it("returns the id of the battle the creator made", () => {
    expect(parseCreatedBattleId(["noise", created(7, "alice.testnet")], "alice.testnet")).toBe(7);
  });
  it("ignores another creator, other events and malformed lines", () => {
    const other = `EVENT_JSON:${JSON.stringify({ event: "deposit", data: [{ battle_id: 3, creator: "alice.testnet" }] })}`;
    expect(parseCreatedBattleId([created(7, "bob.testnet"), other, "EVENT_JSON:{oops"], "alice.testnet")).toBeNull();
  });
});

describe("readCreatedBattleId", () => {
  const tx = (logs: string[]) => async () => new Response(JSON.stringify({ result: { receipts_outcome: [{ outcome: { logs } }] } }), { status: 200 });
  it("reads the id from the receipts' logs", async () => {
    expect(await readCreatedBattleId("https://rpc", "hash", "alice.testnet", tx([created(9, "alice.testnet")]))).toBe(9);
  });
  it("is null when the outcome has no created event", async () => {
    expect(await readCreatedBattleId("https://rpc", "hash", "alice.testnet", tx([]))).toBeNull();
  });
  it("throws when the RPC has no outcome", async () => {
    const down = async () => new Response(JSON.stringify({ error: { message: "unknown transaction" } }), { status: 200 });
    await expect(readCreatedBattleId("https://rpc", "hash", "alice.testnet", down)).rejects.toThrow("unknown transaction");
  });
});

describe("readCommunityIndex", () => {
  const view = (battle: unknown) => async () =>
    new Response(JSON.stringify({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify(battle))) } }), { status: 200 });
  it("finds the position of the representation", async () => {
    const f = view({ communities: [{ representation: "a.testnet" }, { representation: "b.testnet" }] });
    expect(await readCommunityIndex("https://rpc", "arena.testnet", 1, "b.testnet", f)).toBe(1);
  });
  it("is null when the community has not joined", async () => {
    expect(await readCommunityIndex("https://rpc", "arena.testnet", 1, "c.testnet", view({ communities: [] }))).toBeNull();
  });
});

describe("firstDepositProblems", () => {
  it("accepts an amount within the balance", () => {
    expect(firstDepositProblems("a.testnet", "100", "100")).toEqual([]);
  });
  it("requires a token and a positive integer amount", () => {
    expect(firstDepositProblems("", "0", "5")).toHaveLength(2);
  });
  it("rejects more than the balance", () => {
    expect(firstDepositProblems("a.testnet", "101", "100")).toEqual(["the amount is more than your balance of this token"]);
  });
});

describe("readCommunityReadiness", () => {
  const view = (battle: unknown) => async () =>
    new Response(JSON.stringify({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify(battle))) } }), { status: 200 });
  it("is not approved while the audit or the backing approval is missing", async () => {
    const f = view({ communities: [{ representation: "a.testnet", audit_evidence_hash: null, backing_evidence_hash: "b" }] });
    expect(await readCommunityReadiness("https://rpc", "arena.testnet", 1, "a.testnet", f)).toEqual({ index: 0, approved: false });
  });
  it("is approved with both approvals", async () => {
    const f = view({ communities: [{ representation: "a.testnet", audit_evidence_hash: "a", backing_evidence_hash: "b" }] });
    expect(await readCommunityReadiness("https://rpc", "arena.testnet", 1, "a.testnet", f)).toEqual({ index: 0, approved: true });
  });
  it("is null before the community is listed", async () => {
    expect(await readCommunityReadiness("https://rpc", "arena.testnet", 1, "a.testnet", view({ communities: [] }))).toBeNull();
  });
});
