import type { CallReview } from "./create-review";
import type { ActionClientDeps } from "@/lib/terminal/actions";

/**
 * Review model of the participation flow (issue #149): register a position (storage payment), then deposit
 * the community's representation with `ft_transfer_call`. Arguments mirror the agent's action preview
 * (`agent/src/mcp/actions/preview.ts`), so the page shows what the wallet would be asked to sign and the
 * service's canonical preview is compared to it before anything is authorized. A confirmed transaction is
 * not a credited position: the arena can refund an `ft_transfer_call`, so credit is read separately.
 */

/** Upper bound of the registration storage deposit the agent previews; the arena refunds the rest. */
export const REGISTER_DEPOSIT_YOCTO = "10000000000000000000000";
export const REGISTER_GAS_TGAS = "30";
export const DEPOSIT_GAS_TGAS = "100";
const AMOUNT = /^[1-9][0-9]{0,38}$/;
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const validAccount = (s: string): boolean => s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);

export type Review = ({ ok: true } & CallReview) | { ok: false; problems: string[] };

const idProblems = (battleId: number, community: number): string[] => [
  ...(!Number.isSafeInteger(battleId) || battleId < 1 ? ["battle id must be a positive integer"] : []),
  ...(!Number.isSafeInteger(community) || community < 0 || community > 15 ? ["community must be 0 to 15"] : []),
];

export const registerRequest = (battleId: number, community: number) => ({ kind: "register_position", battleId, community });
export const depositRequest = (battleId: number, community: number, amount: string) => ({ kind: "deposit", battleId, community, amount });

export function buildRegisterReview(arena: string, battleId: number, community: number): Review {
  const problems = [...idProblems(battleId, community), ...(validAccount(arena) ? [] : ["the arena contract id is not configured"])];
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    receiver: arena,
    method: "register_lifecycle_position",
    args: { battle_id: battleId, community },
    depositYocto: REGISTER_DEPOSIT_YOCTO,
    gasTgas: REGISTER_GAS_TGAS,
    lines: [
      { label: "Contract", value: arena },
      { label: "Method", value: "register_lifecycle_position" },
      { label: "Battle / community", value: `#${battleId} / community ${community + 1}` },
      { label: "Storage deposit (upper bound)", value: `${REGISTER_DEPOSIT_YOCTO} yoctoNEAR` },
      { label: "Gas", value: `${REGISTER_GAS_TGAS} Tgas` },
    ],
    notes: [
      "The deposit pays for storage; it is not a stake. The arena keeps the actual storage cost and refunds the rest.",
      "Registering moves no tokens. Your position is credited only after a deposit is accepted.",
    ],
  };
}

export function buildDepositReview(input: { arena: string; representation: string; battleId: number; community: number; amount: string }): Review {
  const { arena, representation, battleId, community, amount } = input;
  const problems = [
    ...idProblems(battleId, community),
    ...(AMOUNT.test(amount) ? [] : ["amount must be a positive integer in token base units"]),
    ...(validAccount(arena) ? [] : ["the arena contract id is not configured"]),
    ...(validAccount(representation) ? [] : ["the community representation is not a valid NEAR account id"]),
  ];
  if (problems.length > 0) return { ok: false, problems };
  const msg = JSON.stringify({ action: "lifecycle_deposit", battle_id: battleId, community });
  return {
    ok: true,
    receiver: representation,
    method: "ft_transfer_call",
    args: { receiver_id: arena, amount, msg },
    depositYocto: "1",
    gasTgas: DEPOSIT_GAS_TGAS,
    lines: [
      { label: "Token contract", value: representation },
      { label: "Method", value: "ft_transfer_call" },
      { label: "Recipient", value: arena },
      { label: "Amount", value: `${amount} base units` },
      { label: "Battle / community", value: `#${battleId} / community ${community + 1}` },
      { label: "Attached deposit", value: "1 yoctoNEAR (required by ft_transfer_call)" },
      { label: "Gas", value: `${DEPOSIT_GAS_TGAS} Tgas` },
    ],
    notes: [
      "A deposit after the battle locks is returned by the arena and credits nothing.",
      "A confirmed transaction is not a credited position: the arena can refund the transfer. Credit is read separately below.",
    ],
  };
}

export type CreditState = "credited" | "partial" | "not_credited" | "unknown";

/** Compares the position amount before and after a deposit with the amount requested. Reads only; never a receipt. */
export function creditOutcome(before: string | null, after: string | null, requested: string): { state: CreditState; delta: string } {
  if (before === null || after === null) return { state: "unknown", delta: "0" };
  const delta = BigInt(after) - BigInt(before);
  if (delta < 0n) return { state: "unknown", delta: "0" };
  if (delta === 0n) return { state: "not_credited", delta: "0" };
  return { state: delta >= BigInt(requested) ? "credited" : "partial", delta: delta.toString() };
}

/** The account's position as the arena reports it through the action status attribution. Null when unavailable. */
export async function readCredit(actionId: string, deps: ActionClientDeps): Promise<{ registered: boolean; amount: string } | null> {
  const doFetch = deps.fetchImpl ?? ((u: string, i: RequestInit) => fetch(u, i));
  const res = await doFetch(`${deps.baseUrl ?? "/api/arena/actions"}/${actionId}`, { method: "GET", headers: { authorization: `Bearer ${deps.session}` } });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as { data?: { attribution?: { position?: { registered?: unknown; amount?: unknown } | null } } };
  const position = json.data?.attribution?.position;
  if (!position || typeof position.registered !== "boolean" || typeof position.amount !== "string") return null;
  return { registered: position.registered, amount: position.amount };
}
