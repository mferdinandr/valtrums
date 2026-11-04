import type { BattleStatus } from "./types";

export const TIMELINE: readonly BattleStatus[] = ["Proposed", "Approved", "Live", "Settling", "Settled"] as const;

export const STATUS_LABEL: Record<BattleStatus, string> = {
  Proposed: "Proposed",
  Approved: "Approved",
  Live: "Live",
  Settling: "Settling",
  Settled: "Settled",
  EmergencyHalted: "Halted",
  Voided: "Voided",
};

export type Tone = "green" | "pink" | "cyan" | "amber" | "red" | "mute";

export const STATUS_TONE: Record<BattleStatus, Tone> = {
  Proposed: "mute",
  Approved: "cyan",
  Live: "green",
  Settling: "amber",
  Settled: "pink",
  EmergencyHalted: "red",
  Voided: "red",
};

export const STATUS_FILTERS: readonly { value: BattleStatus | "All"; label: string }[] = [
  { value: "All", label: "All" },
  { value: "Proposed", label: "Proposed" },
  { value: "Approved", label: "Approved" },
  { value: "Live", label: "Live" },
  { value: "Settling", label: "Settling" },
  { value: "Settled", label: "Settled" },
  { value: "EmergencyHalted", label: "Halted" },
  { value: "Voided", label: "Voided" },
];

/** True when the status is a failure branch that ends the normal timeline. */
export function isAborted(status: BattleStatus): boolean {
  return status === "EmergencyHalted" || status === "Voided";
}

/** True when stakes are returned in full through `withdraw_initial_deposit`. */
export function isRefundable(status: BattleStatus): boolean {
  return isAborted(status);
}
