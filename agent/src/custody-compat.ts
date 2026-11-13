import { normalizeAddress } from "./evm-abi.js";

/**
 * Custody compatibility gate (OpenSpec arena-testnet-integrations, issue #148).
 *
 * A source-chain deposit is only spendable by a payout when the address that HOLDS the tokens is the
 * address the payout contract signs for (its configured `sender`, derived from the MPC path). Anything
 * else, including a contract that has no way to move tokens out, is a one-way door: deposits succeed and
 * can never be paid. This is a hard financial capability gate, not a warning.
 *
 * The check is deliberately conservative and uses only facts the caller has read: it never infers that
 * "an MPC key can probably spend" and it never treats a different prefunded balance as proof.
 */

export interface CustodyFacts {
  /** The address that emits the Deposited event (the deposit-attribution contract). */
  depositContract: string;
  /** The address that actually holds the tokens after a deposit. Equal to `depositContract` when tokens stay in it. */
  tokenHolder: string;
  /** The custody account the payout contract signs for (`BackingConfig.sender`). */
  payoutSender: string;
  /** Runtime code of the holder, as a keccak256 hex string, or null for an account without code (an EOA). */
  holderCodeHash: string | null;
}

export type CustodyVerdict =
  | { spendable: true; reasons: [] }
  | { spendable: false; reasons: string[] };

/**
 * Runtime code hashes reviewed to be able to pay out only to the payout sender. Empty by design: no
 * custody contract has been reviewed for this yet, so a holder that is a contract is never accepted.
 */
export const REVIEWED_SPENDABLE_HOLDER_CODE_HASHES: ReadonlySet<string> = new Set();

/**
 * Known deposit-only runtime code (no withdrawal, sweep or execute path). The retired
 * `TestnetDepositCustody` contract is deposit-attribution only: tokens it holds can never leave. Filled in at deployment with the
 * code hash actually read from chain; any hash listed here is refused even if a config claims otherwise.
 */
export const KNOWN_DEPOSIT_ONLY_CODE_HASHES: ReadonlySet<string> = new Set();

export function assessCustody(facts: CustodyFacts): CustodyVerdict {
  const reasons: string[] = [];
  let holder: string;
  let sender: string;
  try {
    holder = normalizeAddress(facts.tokenHolder);
    sender = normalizeAddress(facts.payoutSender);
    normalizeAddress(facts.depositContract);
  } catch {
    return { spendable: false, reasons: ["custody addresses are not valid 20-byte hex addresses"] };
  }
  const code = facts.holderCodeHash?.toLowerCase() ?? null;
  if (code !== null && KNOWN_DEPOSIT_ONLY_CODE_HASHES.has(code)) {
    reasons.push("the token holder runs known deposit-only code: tokens deposited there can never be paid out");
  } else if (holder !== sender) {
    reasons.push(`tokens are held by ${holder} but the payout contract signs for ${sender}: the signing account cannot spend them`);
  }
  if (holder === sender && code !== null && !REVIEWED_SPENDABLE_HOLDER_CODE_HASHES.has(code)) {
    reasons.push("the payout sender has contract code that has not been reviewed as spendable; a signing key cannot be assumed to control it");
  }
  return reasons.length === 0 ? { spendable: true, reasons: [] } : { spendable: false, reasons };
}

/**
 * Deposit contracts the operator has retired (for example the deposit-only contract that cannot pay out).
 * Nothing on chain separates their events from a live contract's under an unchanged domain and mapping
 * version, so the verifier tooling refuses them by address. Returns a reason when `custody` is retired.
 */
export function retiredCustodyReason(custody: string, retired: readonly string[]): string | null {
  const target = normalizeAddress(custody);
  for (const r of retired) {
    if (normalizeAddress(r) === target) return `the deposit contract ${target} is retired: its deposits can never be paid out and must not be attested`;
  }
  return null;
}
