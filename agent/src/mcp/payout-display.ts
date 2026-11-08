import type { PayoutState } from "./read-source.js";

/**
 * User-facing payout stages, kept separate so a signature or a broadcast is never shown as paid.
 * `available` is an unreserved entitlement (no payout record yet); every payout record maps to
 * exactly one of the other stages.
 */
export type PayoutDisplayState =
  | "available"
  | "reserved"
  | "broadcast"
  | "confirmation_pending"
  | "confirmed"
  | "reverted"
  | "restored";

const DISPLAY: Record<PayoutState, PayoutDisplayState> = {
  Authorized: "reserved",
  SigningRequested: "reserved",
  Signed: "reserved",
  Broadcast: "broadcast",
  PendingFinality: "confirmation_pending",
  ReconciliationRequired: "confirmation_pending",
  Reverted: "reverted",
  Confirmed: "confirmed",
  Restored: "restored",
};

export const PAYOUT_DISPLAY_LABELS: Record<PayoutDisplayState, string> = {
  available: "Available: entitlement not yet requested",
  reserved: "Reserved: set aside for this payout, not sent",
  broadcast: "Broadcast: sent to the network, not confirmed",
  confirmation_pending: "Confirmation pending: waiting for a verified final receipt",
  confirmed: "Confirmed: finalized receipt verified",
  reverted: "Reverted: the transfer failed on the source chain; it will be retried or restored",
  restored: "Restored: no transfer happened; the amount is back in the entitlement",
};

export function payoutDisplayState(state: PayoutState): PayoutDisplayState {
  return DISPLAY[state];
}
