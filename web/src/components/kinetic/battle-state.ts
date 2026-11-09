import type { BattleStatus, Side } from "@/lib/arena/types";

export type DepositPhase =
  | "idle"
  | "preview"
  | "review"
  | "pending"
  | "submitted"
  | "success"
  | "error";
export interface BattleControls {
  selected: Side;
  onSelect: (side: Side) => void;
  selectable: boolean;
  lockedSide: Side | null;
  phase: DepositPhase;
  status: BattleStatus;
  winner: Side | null;
  symbols: [string, string];
  progress: number;
}
