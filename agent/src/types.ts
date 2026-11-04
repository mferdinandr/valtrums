/** Wire types of the arena contract. u64/u128 values are decimal strings in JSON. */
export type Side = "A" | "B";

export type BattleStatus =
  | "Proposed"
  | "Approved"
  | "Live"
  | "Settling"
  | "Settled"
  | "EmergencyHalted"
  | "Voided";

export interface BattleView {
  id: number;
  creator: string;
  token_a: string;
  token_b: string;
  bond: string;
  duration_ns: string;
  deposit_deadline_ns: string;
  status: BattleStatus;
  vault_a: string;
  vault_b: string;
  start_time_ns: string;
  end_time_ns: string;
  initial_price_a: string | null;
  initial_price_b: string | null;
  final_price_a: string | null;
  final_price_b: string | null;
  winner: Side | null;
}

export interface SettlementStep {
  index: number;
  kind: "Dump" | "Buy" | "Burn" | "Return";
  amount: string;
  done: boolean;
  realized: string | null;
}

export interface ConfigView {
  owner: string;
  usdc: string;
  treasury: string;
  bond: string;
  agents: string[];
  paused: boolean;
}
