import { rpcView } from "./agent-grant";

/**
 * First deposit of the creator (issue #149 follow-up). `create_lifecycle_battle` returns the new id only to the
 * wallet, so the id is read back from the transaction's `lifecycle_battle_created` event, and the creator's
 * community index from the arena's own view. Nothing here signs or trusts a receipt as credit.
 */

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const AMOUNT = /^[1-9][0-9]{0,38}$/;

/** The id of the battle `creator` created, from the NEP-297 logs of a transaction. Null when no such event is present. */
export function parseCreatedBattleId(logs: readonly string[], creator: string): number | null {
  for (const line of logs) {
    if (!line.startsWith("EVENT_JSON:")) continue;
    try {
      const body = JSON.parse(line.slice("EVENT_JSON:".length)) as { event?: unknown; data?: Array<{ battle_id?: unknown; creator?: unknown }> };
      if (body.event !== "lifecycle_battle_created") continue;
      for (const d of body.data ?? []) {
        if (d.creator === creator && typeof d.battle_id === "number" && Number.isSafeInteger(d.battle_id) && d.battle_id >= 1) return d.battle_id;
      }
    } catch {
      // A log line that is not valid JSON is not our event.
    }
  }
  return null;
}

/** Reads the battle id from a confirmed create transaction over RPC. Null while the outcome has no such event. */
export async function readCreatedBattleId(
  rpcUrl: string, txHash: string, creator: string, doFetch: FetchLike = (u, i) => fetch(u, i),
): Promise<number | null> {
  const res = await doFetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "valtrum", method: "tx", params: { tx_hash: txHash, sender_account_id: creator, wait_until: "EXECUTED" } }),
  });
  if (!res.ok) throw new Error(`RPC error ${res.status}`);
  const body = (await res.json()) as { result?: { receipts_outcome?: Array<{ outcome?: { logs?: string[] } }> }; error?: { message?: string } };
  if (body.error || !body.result) throw new Error(body.error?.message ?? "transaction outcome unavailable");
  const logs = (body.result.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? []);
  return parseCreatedBattleId(logs, creator);
}

/** Index of `representation` among the battle's communities as the arena reports it, or null when it is not there yet. */
export async function readCommunityIndex(
  rpcUrl: string, arena: string, battleId: number, representation: string, doFetch?: FetchLike,
): Promise<number | null> {
  const battle = await rpcView<{ communities?: Array<{ representation?: string }> }>(rpcUrl, arena, "get_lifecycle_battle", { battle_id: battleId }, doFetch);
  const index = battle?.communities?.findIndex((c) => c.representation === representation) ?? -1;
  return index >= 0 ? index : null;
}

/** Reasons the first deposit cannot be signed with this token, amount and balance. Empty means it can. */
export function firstDepositProblems(representation: string, amount: string, balance: string | null): string[] {
  const out: string[] = [];
  if (!representation) out.push("choose the token you deposit first");
  if (!AMOUNT.test(amount)) out.push("enter the deposit amount in the token's smallest unit");
  else if (balance !== null && BigInt(amount) > BigInt(balance)) out.push("the amount is more than your balance of this token");
  return out;
}
