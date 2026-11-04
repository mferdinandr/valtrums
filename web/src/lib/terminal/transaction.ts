// The deposit transaction: built from a plan, and checked against the confirmed plan before anything is signed.

import type { DepositPlan } from "./plan";

export const GAS_FT_TRANSFER_CALL = "100 Tgas";
export const ONE_YOCTO = "1";

export interface TransferCallTx {
  /** USDC contract. */
  receiverId: string;
  method: "ft_transfer_call";
  args: { receiver_id: string; amount: string; msg: string };
  gas: string;
  /** Attached deposit in yoctoNEAR. */
  deposit: string;
}

/** Credit-only deposits: a zero-amount `ft_transfer_call` is impossible, so the arena is called directly. */
export interface CreditDepositTx {
  /** Arena contract. */
  receiverId: string;
  method: "deposit_with_credit";
  args: { battle_id: number; side: "A" | "B"; total_usdc: string; min_token_out: string };
  gas: string;
  deposit: string;
}

export type DepositTx = TransferCallTx | CreditDepositTx;

export interface DepositMsg {
  action: "deposit_usdc";
  battle_id: number;
  side: "A" | "B";
  total_usdc: string;
  min_token_out: string;
}

/** Interface.md: step 1 `ft_transfer_call` with the `deposit_usdc` message, or `deposit_with_credit` when no USDC leaves the wallet. */
export function buildDepositTx(plan: DepositPlan): DepositTx {
  const fields = { battle_id: plan.battleId, side: plan.side, total_usdc: plan.totalUnits.toString(), min_token_out: plan.minOut.toString() };
  if (plan.walletUnits === 0n) {
    return { receiverId: plan.arenaId, method: "deposit_with_credit", args: fields, gas: GAS_FT_TRANSFER_CALL, deposit: ONE_YOCTO };
  }
  const msg: DepositMsg = { action: "deposit_usdc", ...fields };
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
  if (tx.deposit !== ONE_YOCTO) bad.push("attached deposit is not exactly 1 yoctoNEAR");
  const expected: Record<string, unknown> = {
    battle_id: plan.battleId,
    side: plan.side,
    total_usdc: plan.totalUnits.toString(),
    min_token_out: plan.minOut.toString(),
  };
  let fields: Record<string, unknown>;

  if (plan.walletUnits === 0n) {
    if (tx.method !== "deposit_with_credit") return { ok: false, mismatches: [...bad, `method ${String(tx.method)} is not deposit_with_credit`] };
    if (tx.receiverId !== plan.arenaId) bad.push(`contract ${tx.receiverId} is not the arena ${plan.arenaId}`);
    fields = tx.args as Record<string, unknown>;
  } else {
    if (tx.method !== "ft_transfer_call") return { ok: false, mismatches: [...bad, `method ${String(tx.method)} is not ft_transfer_call`] };
    if (tx.receiverId !== plan.usdcId) bad.push(`token contract ${tx.receiverId} is not the USDC contract ${plan.usdcId}`);
    if (tx.args.receiver_id !== plan.arenaId) bad.push(`recipient ${tx.args.receiver_id} is not the arena ${plan.arenaId}`);
    if (tx.args.amount !== plan.walletUnits.toString()) bad.push(`amount ${tx.args.amount} differs from the confirmed wallet part ${plan.walletUnits}`);
    let msg: unknown;
    try {
      msg = JSON.parse(tx.args.msg);
    } catch {
      return { ok: false, mismatches: [...bad, "message is not valid JSON"] };
    }
    fields = (typeof msg === "object" && msg !== null ? msg : {}) as Record<string, unknown>;
    expected.action = "deposit_usdc";
  }
  for (const [k, v] of Object.entries(expected)) if (fields[k] !== v) bad.push(`${k} is ${JSON.stringify(fields[k])}, confirmed ${JSON.stringify(v)}`);
  for (const k of Object.keys(fields)) if (!(k in expected)) bad.push(`unconfirmed field "${k}"`);
  return bad.length === 0 ? { ok: true } : { ok: false, mismatches: bad };
}
