import type { CallReview } from "./create-review";
import { rpcView } from "./agent-grant";

/**
 * Claiming an entitlement (a reward or a DAO return) into the caller's NEAR account as representation tokens,
 * 1:1 with the custody on the source chain. The reviews mirror the action service's preview
 * (`agent/src/mcp/actions/lifecycle-actions.ts`) so the canonical preview can be compared before signing.
 */

export const CLAIM_GAS_TGAS = "30";
export const REGISTER_GAS_TGAS = "30";
/** 0.01 NEAR; a registration-only NEP-145 deposit is refunded above the token's minimum. */
export const REGISTER_DEPOSIT_YOCTO = "10000000000000000000000";

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const validAccount = (s: string): boolean => s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);
const AMOUNT = /^[1-9][0-9]{0,38}$/;

export type Review = ({ ok: true } & CallReview) | { ok: false; problems: string[] };

export const claimRequest = (backing: string, amount: string) => ({ kind: "claim_entitlement", backing, amount });
export const registerRequest = (backing: string) => ({ kind: "register_representation", backing });

export function buildClaimReview(backing: string, amount: string, label?: string): Review {
  const problems = [
    ...(validAccount(backing) ? [] : ["the token contract is not valid"]),
    ...(AMOUNT.test(amount) ? [] : ["the amount must be a positive whole number of base units"]),
  ];
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    receiver: backing,
    method: "claim_entitlement_as_representation",
    args: { amount },
    depositYocto: "1",
    gasTgas: CLAIM_GAS_TGAS,
    lines: [
      { label: "Contract", value: backing },
      { label: "Method", value: "claim_entitlement_as_representation" },
      { label: "Token", value: label ? `${label} · ${backing}` : backing },
      { label: "Amount (base units)", value: amount },
      { label: "Attached deposit", value: "1 yoctoNEAR" },
      { label: "Gas", value: `${CLAIM_GAS_TGAS} Tgas` },
    ],
    notes: [
      "The tokens are minted into your NEAR account from your entitlement, 1:1 with the custody on the source chain, which does not move.",
      "Redeeming them to the source chain is a separate payout request.",
    ],
  };
}

export function buildRegisterReview(backing: string, account: string, label?: string): Review {
  const problems = [
    ...(validAccount(backing) ? [] : ["the token contract is not valid"]),
    ...(validAccount(account) ? [] : ["connect a wallet first"]),
  ];
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    receiver: backing,
    method: "storage_deposit",
    args: { account_id: account, registration_only: true },
    depositYocto: REGISTER_DEPOSIT_YOCTO,
    gasTgas: REGISTER_GAS_TGAS,
    lines: [
      { label: "Contract", value: backing },
      { label: "Method", value: "storage_deposit (registration only)" },
      { label: "Token", value: label ? `${label} · ${backing}` : backing },
      { label: "Storage deposit (upper bound)", value: `${REGISTER_DEPOSIT_YOCTO} yoctoNEAR` },
      { label: "Gas", value: `${REGISTER_GAS_TGAS} Tgas` },
    ],
    notes: ["Lets your account hold this token. It moves no tokens, and the token refunds the part above its minimum."],
  };
}

/** Whether `account` is registered on a token (NEP-145 `storage_balance_of`). */
export async function readRegistered(rpcUrl: string, backing: string, account: string): Promise<boolean> {
  return (await rpcView<unknown>(rpcUrl, backing, "storage_balance_of", { account_id: account })) != null;
}

/** The entitlement of `account` on a backing, in base units, read from the backing itself (no wallet signature). */
export async function readEntitlement(rpcUrl: string, backing: string, account: string): Promise<string> {
  const value = await rpcView<string>(rpcUrl, backing, "entitlement_of", { account });
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? value : "0";
}

// ---------------------------------------------------------------- settle the prizes

/** Per entitlement forwarded to a backing (arena ENTITLEMENT_DEPOSIT, 10 mNEAR). Mirrors agent/src/mcp/actions/preview.ts. */
export const ENTITLEMENT_DEPOSIT_YOCTO = 10_000_000_000_000_000_000_000n;
export const MAX_SETTLE_BATCH = 15;
export const SETTLE_GAS_TGAS = "300";

export const settleRequest = (battleId: number) => ({ kind: "settle_battle", battleId });

export interface SettlementProgress {
  recorded: number;
  total: number;
}

/** How many of the battle's prize entitlements the arena has recorded; null before a winner or for an unknown battle. */
export async function readSettlement(rpcUrl: string, arena: string, battleId: number): Promise<SettlementProgress | null> {
  const v = await rpcView<{ recorded?: number; total?: number }>(rpcUrl, arena, "get_settlement_progress", { battle_id: String(battleId) });
  return v && Number.isInteger(v.recorded) && Number.isInteger(v.total) ? { recorded: v.recorded as number, total: v.total as number } : null;
}

/** The next batch: as many entitlements as fit in one call, repeated until recorded equals total. */
export function settleBatch(p: SettlementProgress): number {
  return Math.max(0, Math.min(MAX_SETTLE_BATCH, p.total - p.recorded));
}

export function buildSettleReview(arena: string, battleId: number, p: SettlementProgress): Review {
  const batch = settleBatch(p);
  const problems = [
    ...(Number.isSafeInteger(battleId) && battleId >= 1 ? [] : ["battle id must be a positive integer"]),
    ...(validAccount(arena) ? [] : ["the arena contract id is not configured"]),
    ...(batch > 0 ? [] : ["every prize is already recorded"]),
  ];
  if (problems.length > 0) return { ok: false, problems };
  const deposit = (ENTITLEMENT_DEPOSIT_YOCTO * BigInt(batch)).toString();
  return {
    ok: true,
    receiver: arena,
    method: "settle_lifecycle_battle",
    args: { battle_id: String(battleId), max_entitlements: batch },
    depositYocto: deposit,
    gasTgas: SETTLE_GAS_TGAS,
    lines: [
      { label: "Contract", value: arena },
      { label: "Method", value: "settle_lifecycle_battle" },
      { label: "Battle", value: `#${battleId}` },
      { label: "Prizes in this batch", value: `${batch} of ${p.total - p.recorded} remaining` },
      { label: "Attached deposit", value: `${deposit} yoctoNEAR` },
      { label: "Gas", value: `${SETTLE_GAS_TGAS} Tgas` },
    ],
    notes: [
      "Anyone may settle. The arena works the split out from the frozen snapshot, so the caller cannot influence it.",
      "The arena refunds unused deposit. Repeat until every prize is recorded; a failed batch advances nothing.",
    ],
  };
}
