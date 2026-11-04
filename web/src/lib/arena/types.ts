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

export interface WithdrawLiquidInput {
  signerId: string;
  /** NEP-141 contract of the balance to pay out. */
  token: string;
  /** Base units of that token. */
  amount: bigint;
}

export interface BattleActionInput {
  signerId: string;
  battleId: number;
}

export interface FundBalanceInput {
  signerId: string;
  /** USDC base units moved from the wallet into the arena's internal balance. */
  amount: bigint;
}

export interface DepositFromBalanceInput {
  signerId: string;
  battleId: number;
  side: Side;
  /** Total USDC value of the deposit. Credit is spent first, then the internal balance. */
  totalUsdc: bigint;
  /** Least coin output (base units) the swap may return. */
  minTokenOut: bigint;
}

export interface ArenaApi {
  readonly mode: "mock" | "near";
  getConfig(): Promise<ConfigView>;
  getBattleCount(): Promise<number>;
  getBattles(fromIndex: number, limit: number): Promise<BattleView[]>;
  getBattle(battleId: number): Promise<BattleView | null>;
  getPosition(battleId: number, accountId: string): Promise<PositionView | null>;
  getAccount(accountId: string): Promise<AccountView>;
  /** Liquid (withdrawable) balance of one token, in that token's base units (U128 string). */
  getLiquidBalance(accountId: string, tokenId: string): Promise<string>;
  getSettlementPlan(battleId: number): Promise<SettlementStep[]>;
  getTokenMeta(tokenId: string): Promise<TokenMeta>;
  /** Spot prices while a battle is live, or null when no price source is available. */
  getLivePrices(battleId: number): Promise<LivePrices | null>;

  proposeBattle(input: ProposeInput): Promise<void>;
  depositCoin(input: DepositInput): Promise<void>;
  claim(input: BattleActionInput): Promise<void>;
  withdrawInitialDeposit(input: BattleActionInput): Promise<void>;
  /**
   * Pays a liquid balance out to the wallet. If the token transfer fails the contract restores the
   * balance, so callers should re-read it after the call.
   */
  withdrawLiquid(input: WithdrawLiquidInput): Promise<void>;
  /**
   * Moves wallet USDC into the arena's internal balance (`ft_transfer_call` with `fund_balance`, 1 yoctoNEAR,
   * full-access approval). The balance can be withdrawn any time with `withdrawLiquid`.
   */
  fundBalance(input: FundBalanceInput): Promise<void>;
  /**
   * Deposits into a battle from credit and the internal balance (`deposit_from_balance`). No attached
   * deposit, so a scoped session key can sign it. If the swap fails the contract restores credit and
   * balance and nothing is deposited.
   */
  depositFromBalance(input: DepositFromBalanceInput): Promise<void>;
}
