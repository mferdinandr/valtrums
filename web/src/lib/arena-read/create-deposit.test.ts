// FIXTURE-ONLY: a fake RPC. Nothing here touches a chain.
import { describe, expect, it } from "vitest";
import { firstDepositProblems, parseCreatedBattleId, parseCreateRefusal, readCreateOutcome, readCreatedBattleId, readStorageBalance } from "./create-deposit";

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

const refused = (reason: string, who: string) =>
  `EVENT_JSON:${JSON.stringify({ standard: "valtrum", version: "1", event: "lifecycle_create_refused", data: [{ account_id: who, representation: "a.testnet", reason }] })}`;

describe("parseCreateRefusal", () => {
  it("returns the reason the arena gave for this creator", () => {
    expect(parseCreateRefusal(["noise", refused("the token is not joinable", "alice.testnet")], "alice.testnet")).toBe("the token is not joinable");
  });
  it("ignores another account and other events", () => {
    expect(parseCreateRefusal([refused("x", "bob.testnet"), created(7, "alice.testnet")], "alice.testnet")).toBeNull();
  });
});

describe("readCreateOutcome", () => {
  const tx = (logs: string[]) => async () => new Response(JSON.stringify({ result: { receipts_outcome: [{ outcome: { logs } }] } }), { status: 200 });
  it("reports the new battle id", async () => {
    expect(await readCreateOutcome("https://rpc", "hash", "alice.testnet", tx([created(9, "alice.testnet")]))).toEqual({ battleId: 9 });
  });
  it("reports a refusal, because a refused creation still succeeds as a transaction", async () => {
    expect(await readCreateOutcome("https://rpc", "hash", "alice.testnet", tx([refused("the start time must be 1 minute to 7 days ahead", "alice.testnet")]))).toEqual({
      refused: "the start time must be 1 minute to 7 days ahead",
    });
  });
  it("is null while the outcome has neither event", async () => {
    expect(await readCreateOutcome("https://rpc", "hash", "alice.testnet", tx([]))).toBeNull();
  });
});

describe("readStorageBalance", () => {
  const view = (value: unknown) => async () =>
    new Response(JSON.stringify({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } }), { status: 200 });
  it("reads the prepaid balance as a bigint", async () => {
    expect(await readStorageBalance("https://rpc", "arena.testnet", "alice.testnet", view("50000000000000000000000"))).toBe(50000000000000000000000n);
  });
  it("is zero for an account that never prepaid", async () => {
    expect(await readStorageBalance("https://rpc", "arena.testnet", "alice.testnet", view("0"))).toBe(0n);
  });
});
