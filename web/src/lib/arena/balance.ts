import { USDC_DECIMALS, formatUsdc, parseUnits } from "../amounts";

export type FundAmountCheck = { ok: true; units: bigint } | { ok: false; error: string };

/** Validates a typed amount against the USDC the wallet holds. Pure so the form and tests share it. */
export function checkFundAmount(input: string, walletUsdc: bigint): FundAmountCheck {
  const units = parseUnits(input, USDC_DECIMALS);
  if (units === null) return { ok: false, error: "Enter a USDC amount with at most 6 decimals." };
  if (units <= 0n) return { ok: false, error: "The amount must be greater than zero." };
  if (units > walletUsdc) return { ok: false, error: `Your wallet holds ${formatUsdc(walletUsdc)} USDC.` };
  return { ok: true, units };
}
