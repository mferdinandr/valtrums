// FIXTURE-ONLY: a fake RPC. Nothing here touches a chain.
import { describe, expect, it } from "vitest";
import { readMyPositions } from "./positions";

const enc = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
const rpc = (byCommunity: Record<number, { registered: boolean; amount: string }>) => async (_u: string, init: RequestInit) => {
  const params = JSON.parse(String(init.body)).params as { args_base64: string };
  const args = JSON.parse(atob(params.args_base64)) as { community: number; account: string };
  return new Response(JSON.stringify({ result: { result: enc(byCommunity[args.community] ?? { registered: false, amount: "0" }) } }), { status: 200 });
};

describe("readMyPositions", () => {
  it("returns only the communities where the account registered or holds an amount", async () => {
    const f = rpc({ 1: { registered: true, amount: "100" }, 2: { registered: true, amount: "0" } });
    expect(await readMyPositions("https://rpc", "arena.testnet", 9, "alice.testnet", 3, f)).toEqual([
      { community: 1, registered: true, amount: "100" },
      { community: 2, registered: true, amount: "0" },
    ]);
  });
  it("is empty when the account has no position", async () => {
    expect(await readMyPositions("https://rpc", "arena.testnet", 9, "alice.testnet", 2, rpc({}))).toEqual([]);
  });
});
