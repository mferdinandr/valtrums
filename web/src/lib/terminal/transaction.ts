// The deposit transaction: built from a plan, and checked against the confirmed plan before anything is signed.

import type { DepositPlan } from "./plan";

export const GAS_FT_TRANSFER_CALL = "100 Tgas";
export const ONE_YOCTO = "1";

/** `ft_transfer_call` on USDC to the arena (interface.md, USDC deposit step 1). */
export interface DepositTx {
  receiverId: string;
  method: "ft_transfer_call";
  args: { receiver_id: string; amount: string; msg: string };
  gas: string;
  /** Attached deposit in yoctoNEAR. */
  deposit: string;
}

export interface DepositMsg {
  action: "deposit_usdc";
  battle_id: number;
  side: "A" | "B";
  total_usdc: string;
  min_token_out: string;
}

export function buildDepositTx(plan: DepositPlan): DepositTx {
  const msg: DepositMsg = {
    action: "deposit_usdc",
    battle_id: plan.battleId,
    side: plan.side,
    total_usdc: plan.totalUnits.toString(),
    min_token_out: plan.minOut.toString(),
  };
  return {
    receiverId: plan.usdcId,
    method: "ft_transfer_call",
    args: { receiver_id: plan.arenaId, amount: plan.walletUnits.toString(), msg: JSON.stringify(msg) },
    gas: GAS_FT_TRANSFER_CALL,
    deposit: ONE_YOCTO,
  };
}

export type VerifyResult = { ok: true } | { ok: false; mismatches: string[] };

/** Compare the structured, confirmed plan with the transaction about to be signed. Any difference aborts. */
export function verifyTx(plan: DepositPlan, tx: DepositTx): VerifyResult {
  const bad: string[] = [];
  if (tx.receiverId !== plan.usdcId) bad.push(`token contract ${tx.receiverId} is not the USDC contract ${plan.usdcId}`);
  if (tx.method !== "ft_transfer_call") bad.push(`method ${String(tx.method)} is not ft_transfer_call`);
  if (tx.deposit !== ONE_YOCTO) bad.push("attached deposit is not exactly 1 yoctoNEAR");
  if (tx.args.receiver_id !== plan.arenaId) bad.push(`recipient ${tx.args.receiver_id} is not the arena ${plan.arenaId}`);
  if (tx.args.amount !== plan.walletUnits.toString()) bad.push(`amount ${tx.args.amount} differs from the confirmed wallet part ${plan.walletUnits}`);

  let msg: unknown;
  try {
    msg = JSON.parse(tx.args.msg);
  } catch {
    return { ok: false, mismatches: [...bad, "message is not valid JSON"] };
  }
  const m = (typeof msg === "object" && msg !== null ? msg : {}) as Record<string, unknown>;
  const expected: Record<string, unknown> = {
    action: "deposit_usdc",
    battle_id: plan.battleId,
    side: plan.side,
    total_usdc: plan.totalUnits.toString(),
    min_token_out: plan.minOut.toString(),
  };
  for (const [k, v] of Object.entries(expected)) if (m[k] !== v) bad.push(`message ${k} is ${JSON.stringify(m[k])}, confirmed ${JSON.stringify(v)}`);
  for (const k of Object.keys(m)) if (!(k in expected)) bad.push(`message has an unconfirmed field "${k}"`);
  return bad.length === 0 ? { ok: true } : { ok: false, mismatches: bad };
}
