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
  /** Sent to the DEX, proceeds pending. Only meaningful with on-chain execution. */
  dispatched: boolean;
  realized: string | null;
}

export interface ConfigView {
  owner: string;
  usdc: string;
  treasury: string;
  bond: string;
  agents: string[];
  paused: boolean;
  /** DEX the arena swaps settlement steps on; null means mock execution. */
  execution_dex: string | null;
  /** Receiver of burned winner coin; null when on-chain execution is off. */
  burn_account: string | null;
}

/** Chain-level settings for foreign-chain signing (`get_foreign_config`). Addresses are hex without 0x. */
export interface ForeignConfigView {
  mpc_contract: string;
  chain_id: string;
  router: string;
  treasury: string;
  burn: string;
}

export type SignStatus = "Pending" | "Signed" | "Failed";

/** A signing request (`get_signature_request`); hex fields have no 0x prefix. */
export interface SignRequestView {
  battle_id: number;
  step_index: number | null;
  path: string;
  status: SignStatus;
  unsigned_tx: string;
  payload_hash: string;
  signed_tx: string | null;
  tx_hash: string | null;
  attempts: number;
}

/** Call to sign, with EVM addresses as hex strings and amounts as bigint. */
export type ForeignCall =
  | { kind: "approve"; token: string; spender: string; amount: bigint }
  | { kind: "transfer"; token: string; to: string; amount: bigint }
  | {
      kind: "swap_exact_in";
      token_in: string;
      token_out: string;
      fee: number;
      recipient: string;
      amount_in: bigint;
      min_out: bigint;
    };

export interface ForeignTxParams {
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
}
