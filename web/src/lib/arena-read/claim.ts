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
