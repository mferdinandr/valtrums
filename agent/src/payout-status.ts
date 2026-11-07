/**
 * Wire types of the payout contract status view (`get_payout`, `list_open_payouts`).
 * u64/u128 values are decimal strings and 20/32-byte values are number arrays in JSON.
 * Documented in docs/openspec/changes/arena-chain-signatures/implementation-notes.md.
 * Variants and fields are only ever added.
 */
export type PayoutState =
  | "authorized"
  | "signing_requested"
  | "signed"
  | "broadcast"
  | "pending_finality"
  | "reverted"
  | "reconciliation_required"
  | "confirmed"
  | "restored";

export type PayoutAttemptState = "requested" | "signed" | "broadcast" | "pending" | "reverted";

export type PayoutHoldReason = "SignerNoResponse" | "BroadcastUnconfirmed" | "EvidenceUnavailable";

export interface PayoutAttemptView {
  /** All zero while `state` is "requested". */
  tx_hash: number[];
  max_fee_per_gas: string;
  state: PayoutAttemptState;
}

export interface PayoutView {
  backing: string;
  holder: string;
  request_id: number[];
  state: PayoutState;
  /** Set only while `state` is "reconciliation_required". */
  reason: PayoutHoldReason | null;
  /** True for "confirmed" and "restored". */
  terminal: boolean;
  chain_id: string;
  token: number[];
  sender: number[];
  destination: number[];
  amount: string;
  path: string;
  nonce: string;
  binding_hash: number[];
  attempts: PayoutAttemptView[];
  /** Set only once `state` is "confirmed". */
  evidence_hash: number[] | null;
}

export interface PayoutPage {
  items: PayoutView[];
  /** Pass as `from_index` for the next page. */
  next_index: string;
}

export const TERMINAL_PAYOUT_STATES: readonly PayoutState[] = ["confirmed", "restored"];

export const isTerminalPayout = (state: PayoutState): boolean => TERMINAL_PAYOUT_STATES.includes(state);
