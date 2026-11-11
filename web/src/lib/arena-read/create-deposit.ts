import { rpcView } from "./agent-grant";

/**
 * Reading the outcome of a battle creation (D41). The arena creates the battle inside `ft_on_transfer`, so the
 * wallet never receives the new id: it is read back from the transaction's `lifecycle_battle_created` event.
 * A creation the arena refuses (a token it does not accept, a start out of range) returns the tokens and the
 * transaction still succeeds, so the refusal is read from `lifecycle_create_refused`. Nothing here signs or
 * trusts a receipt as credit.
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

/** The reason the arena gave for refusing a creation by `creator`, from the NEP-297 logs of a transaction. */
export function parseCreateRefusal(logs: readonly string[], creator: string): string | null {
  for (const line of logs) {
    if (!line.startsWith("EVENT_JSON:")) continue;
    try {
      const body = JSON.parse(line.slice("EVENT_JSON:".length)) as { event?: unknown; data?: Array<{ account_id?: unknown; reason?: unknown }> };
      if (body.event !== "lifecycle_create_refused") continue;
      for (const d of body.data ?? []) {
        if (d.account_id === creator && typeof d.reason === "string") return d.reason;
      }
    } catch {
      // A log line that is not valid JSON is not our event.
    }
  }
  return null;
}

export type CreateOutcome = { battleId: number } | { refused: string } | null;

/** The outcome of a create transaction over RPC. Null while its outcome has neither event yet. */
export async function readCreateOutcome(
  rpcUrl: string, txHash: string, creator: string, doFetch: FetchLike = (u, i) => fetch(u, i),
): Promise<CreateOutcome> {
  const res = await doFetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "valtrum", method: "tx", params: { tx_hash: txHash, sender_account_id: creator, wait_until: "EXECUTED" } }),
  });
  if (!res.ok) throw new Error(`RPC error ${res.status}`);
  const body = (await res.json()) as { result?: { receipts_outcome?: Array<{ outcome?: { logs?: string[] } }> }; error?: { message?: string } };
  if (body.error || !body.result) throw new Error(body.error?.message ?? "transaction outcome unavailable");
  const logs = (body.result.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? []);
  const battleId = parseCreatedBattleId(logs, creator);
  if (battleId !== null) return { battleId };
  const refused = parseCreateRefusal(logs, creator);
  return refused !== null ? { refused } : null;
}

/** Kept for callers that only want the id: null for a refusal or while the outcome has no event. */
export async function readCreatedBattleId(
  rpcUrl: string, txHash: string, creator: string, doFetch?: FetchLike,
): Promise<number | null> {
  const outcome = await readCreateOutcome(rpcUrl, txHash, creator, doFetch);
  return outcome && "battleId" in outcome ? outcome.battleId : null;
}

/** NEAR (yocto) the account prepaid on the arena for battle storage. */
export async function readStorageBalance(rpcUrl: string, arena: string, account: string, doFetch?: FetchLike): Promise<bigint> {
  const raw = await rpcView<string>(rpcUrl, arena, "get_lifecycle_storage_balance", { account_id: account }, doFetch);
  return raw && /^[0-9]+$/.test(raw) ? BigInt(raw) : 0n;
}

/** Reasons the first deposit cannot be signed with this token, amount and balance. Empty means it can. */
export function firstDepositProblems(representation: string, amount: string, balance: string | null): string[] {
  const out: string[] = [];
  if (!representation) out.push("choose the token you deposit first");
  if (!AMOUNT.test(amount)) out.push("enter the deposit amount in the token's smallest unit");
  else if (balance !== null && BigInt(amount) > BigInt(balance)) out.push("the amount is more than your balance of this token");
  return out;
}
