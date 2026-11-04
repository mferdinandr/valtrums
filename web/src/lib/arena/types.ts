// Wire types mirror the arena contract interface. u64/u128 values are decimal strings in JSON.

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

export interface PositionView {
  side: Side;
  coin_amount: string;
  usdc_equiv: string;
  from_credit: string;
  claimed: boolean;
}

export interface AccountView {
  liquid_balance: string;
  credit_balance: string;
  credit_expires_at_ns: string;
}

export interface ConfigView {
  owner: string;
  usdc: string;
  treasury: string;
  bond: string;
  agents: string[];
  paused: boolean;
}

export interface SettlementStep {
  index: number;
  kind: "Dump" | "Buy" | "Burn" | "Return";
  amount: string;
  done: boolean;
  realized: string | null;
}

// ---- UI-side extensions (not part of the contract's view methods) ----

/** NEP-148 subset needed to render amounts and convert coin units to USDC. */
export interface TokenMeta {
  id: string;
  symbol: string;
  decimals: number;
}

/** Current prices, USD per whole coin scaled by 1e18. */
export interface LivePrices {
  a: bigint;
  b: bigint;
}

export interface ProposeInput {
  signerId: string;
  tokenA: string;
  tokenB: string;
  durationSecs: number;
}

export interface DepositInput {
  signerId: string;
  battleId: number;
  side: Side;
  tokenId: string;
  /** Amount in the coin's base units. */
  amount: bigint;
}

export interface BattleActionInput {
  signerId: string;
  battleId: number;
}

export interface ArenaApi {
  readonly mode: "mock" | "near";
  getConfig(): Promise<ConfigView>;
  getBattleCount(): Promise<number>;
  getBattles(fromIndex: number, limit: number): Promise<BattleView[]>;
  getBattle(battleId: number): Promise<BattleView | null>;
  getPosition(battleId: number, accountId: string): Promise<PositionView | null>;
  getAccount(accountId: string): Promise<AccountView>;
  getSettlementPlan(battleId: number): Promise<SettlementStep[]>;
  getTokenMeta(tokenId: string): Promise<TokenMeta>;
  /** Spot prices while a battle is live, or null when no price source is available. */
  getLivePrices(battleId: number): Promise<LivePrices | null>;

  proposeBattle(input: ProposeInput): Promise<void>;
  depositCoin(input: DepositInput): Promise<void>;
  claim(input: BattleActionInput): Promise<void>;
  withdrawInitialDeposit(input: BattleActionInput): Promise<void>;
}
