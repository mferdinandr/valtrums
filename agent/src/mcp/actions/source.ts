import type { SourceInfo } from "../envelope.js";
import type { DispositionView, ReleaseView } from "../account-state.js";
import type { LifecycleBattleView, RoundView, ViewFn } from "../read-source.js";

/**
 * Read-only state the action boundary needs to build and revalidate previews. Like the read
 * source, it has no method that signs, sends or reserves anything.
 */

/** `player-policy.get_grant` view. */
export interface GrantView {
  user: string;
  delegate: string;
  version: string;
  revoked: boolean;
  per_action_cap: string;
  cumulative_cap: string;
  gas_cap: string;
  expiry_ns: string;
}

/** `player-policy.get_budget` view. */
export interface BudgetView {
  authorized_limit: string;
  consumed: string;
  reserved: string;
  available: string;
}

/** `player-policy.get_reservation` view. */
export interface ReservationView {
  state: "reserved" | "dispatched" | "consumed" | "released" | "reconciliation_required";
  amount: string;
  version: string;
  action_hash: number[];
  /** Nanosecond timestamp after which an undispatched reservation can be released (#108). */
  expires_ns?: string;
}

/** `arena.get_lifecycle_joinable_asset` (an `AssetInput`; the chain id is a string). */
export interface JoinableAssetView {
  chain_id: string;
  token_address: string;
  representation: string;
  custody_domain: string;
  reference_chain_id: string | null;
  reference_address: string | null;
}

/** `arena.get_settlement_progress`. */
export interface SettlementProgressView {
  recorded: number;
  total: number;
}

export interface ActionReadSource {
  readonly info: SourceInfo;
  battle(battleId: number): Promise<LifecycleBattleView | null>;
  round(battleId: number): Promise<RoundView | null>;
  position(battleId: number, community: number, account: string): Promise<{ registered: boolean; amount: string }>;
  /** NEP-141 balance of `account` on `token`. */
  tokenBalance(token: string, account: string): Promise<bigint>;
  /** Available (unreserved) settlement entitlement of `account` on a backing. */
  entitlement(backing: string, account: string): Promise<bigint>;
  grant(user: string, localId: number[]): Promise<GrantView | null>;
  budget(user: string, localId: number[]): Promise<BudgetView | null>;
  reservation(user: string, localId: number[], requestId: number[]): Promise<ReservationView | null>;
  /** `get_lifecycle_creator_escrow`: the deposit the creator still has in escrow (D41), or null. */
  creatorEscrow(battleId: number): Promise<{ creator: string; representation: string; amount: string } | null>;
  /** `get_lifecycle_storage_balance`: NEAR (yocto) the account prepaid on the arena for battle storage. */
  storageBalance(account: string): Promise<bigint>;
  /** `get_lifecycle_joinable_asset`: the identity the arena (not the joiner) supplies for a token. */
  joinableAsset(representation: string): Promise<JoinableAssetView | null>;
  /** `get_settlement_progress`; null until a final winner is recorded. */
  settlementProgress(battleId: number): Promise<SettlementProgressView | null>;
  /** `get_lifecycle_disposition`: vote window, tally and execution progress. */
  disposition(battleId: number): Promise<DispositionView | null>;
  /** `get_lifecycle_disposition_releases`: decided releases in execution order. */
  releases(battleId: number): Promise<ReleaseView[]>;
  /** `get_dao_sink` on a backing: the frozen EVM sink address of DAO burns, or null while unset. */
  daoSink(backing: string): Promise<string | null>;
}

const big = (value: unknown, what: string): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`malformed ${what}`);
  return BigInt(value);
};

export class NearActionReadSource implements ActionReadSource {
  constructor(
    readonly info: SourceInfo,
    private readonly view: ViewFn,
    private readonly contracts: { arena: string; policy: string | null },
  ) {}

  async battle(battleId: number): Promise<LifecycleBattleView | null> {
    return ((await this.view(this.contracts.arena, "get_lifecycle_battle", { battle_id: battleId })) ??
      null) as LifecycleBattleView | null;
  }
  async round(battleId: number): Promise<RoundView | null> {
    return ((await this.view(this.contracts.arena, "get_lifecycle_round", { battle_id: String(battleId) })) ??
      null) as RoundView | null;
  }
  async position(battleId: number, community: number, account: string) {
    return (await this.view(this.contracts.arena, "get_lifecycle_position", {
      battle_id: battleId,
      community,
      account,
    })) as { registered: boolean; amount: string };
  }
  async tokenBalance(token: string, account: string): Promise<bigint> {
    return big(await this.view(token, "ft_balance_of", { account_id: account }), "token balance");
  }
  async entitlement(backing: string, account: string): Promise<bigint> {
    return big(await this.view(backing, "entitlement_of", { account }), "entitlement");
  }
  async grant(user: string, localId: number[]): Promise<GrantView | null> {
    if (!this.contracts.policy) return null;
    return ((await this.view(this.contracts.policy, "get_grant", { user, local_id: localId })) ?? null) as GrantView | null;
  }
  async budget(user: string, localId: number[]): Promise<BudgetView | null> {
    if (!this.contracts.policy) return null;
    return ((await this.view(this.contracts.policy, "get_budget", { user, local_id: localId })) ?? null) as BudgetView | null;
  }
  async reservation(user: string, localId: number[], requestId: number[]): Promise<ReservationView | null> {
    if (!this.contracts.policy) return null;
    return ((await this.view(this.contracts.policy, "get_reservation", { user, local_id: localId, request_id: requestId })) ??
      null) as ReservationView | null;
  }
  async creatorEscrow(battleId: number) {
    return ((await this.view(this.contracts.arena, "get_lifecycle_creator_escrow", { battle_id: battleId })) ?? null) as
      | { creator: string; representation: string; amount: string }
      | null;
  }
  async storageBalance(account: string): Promise<bigint> {
    return big(await this.view(this.contracts.arena, "get_lifecycle_storage_balance", { account_id: account }), "storage balance");
  }
  async joinableAsset(representation: string): Promise<JoinableAssetView | null> {
    return ((await this.view(this.contracts.arena, "get_lifecycle_joinable_asset", { representation })) ?? null) as JoinableAssetView | null;
  }
  async settlementProgress(battleId: number): Promise<SettlementProgressView | null> {
    return ((await this.view(this.contracts.arena, "get_settlement_progress", { battle_id: String(battleId) })) ?? null) as SettlementProgressView | null;
  }
  async disposition(battleId: number): Promise<DispositionView | null> {
    return ((await this.view(this.contracts.arena, "get_lifecycle_disposition", { battle_id: String(battleId) })) ?? null) as DispositionView | null;
  }
  async releases(battleId: number): Promise<ReleaseView[]> {
    return ((await this.view(this.contracts.arena, "get_lifecycle_disposition_releases", { battle_id: String(battleId) })) ?? []) as ReleaseView[];
  }
  async daoSink(backing: string): Promise<string | null> {
    const sink = await this.view(backing, "get_dao_sink", {});
    return typeof sink === "string" ? sink : null;
  }
}

/** In-memory source for tests and demos; `info.kind` is always `fixture`. */
export class FixtureActionReadSource implements ActionReadSource {
  readonly info: SourceInfo;
  constructor(
    network: string,
    readonly data: {
      battles: Map<number, LifecycleBattleView>;
      rounds?: Map<number, RoundView>;
      positions?: Map<string, { registered: boolean; amount: string }>;
      balances?: Map<string, bigint>;
      entitlements?: Map<string, bigint>;
      grants?: Map<string, GrantView>;
      budgets?: Map<string, BudgetView>;
      reservations?: Map<string, ReservationView>;
      joinable?: Map<string, JoinableAssetView>;
      /** Prepaid arena storage balance (yocto) per account. */
      storage?: Map<string, bigint>;
      /** Creator escrow held per battle. */
      escrows?: Map<number, { creator: string; representation: string; amount: string }>;
      settlement?: Map<number, SettlementProgressView>;
      dispositions?: Map<number, DispositionView>;
      releases?: Map<number, ReleaseView[]>;
      sinks?: Map<string, string>;
    },
  ) {
    this.info = { network, kind: "fixture", name: "fixture-actions" };
  }
  static key(...parts: (string | number)[]): string {
    return parts.join("|");
  }
  async battle(battleId: number) {
    return this.data.battles.get(battleId) ?? null;
  }
  async round(battleId: number) {
    return this.data.rounds?.get(battleId) ?? null;
  }
  async position(battleId: number, community: number, account: string) {
    return this.data.positions?.get(FixtureActionReadSource.key(battleId, community, account)) ?? { registered: false, amount: "0" };
  }
  async tokenBalance(token: string, account: string) {
    return this.data.balances?.get(FixtureActionReadSource.key(token, account)) ?? 0n;
  }
  async entitlement(backing: string, account: string) {
    return this.data.entitlements?.get(FixtureActionReadSource.key(backing, account)) ?? 0n;
  }
  async grant(user: string, localId: number[]) {
    return this.data.grants?.get(FixtureActionReadSource.key(user, localId.join(","))) ?? null;
  }
  async budget(user: string, localId: number[]) {
    return this.data.budgets?.get(FixtureActionReadSource.key(user, localId.join(","))) ?? null;
  }
  async reservation(user: string, localId: number[], requestId: number[]) {
    return this.data.reservations?.get(FixtureActionReadSource.key(user, localId.join(","), requestId.join(","))) ?? null;
  }
  async creatorEscrow(battleId: number) {
    return this.data.escrows?.get(battleId) ?? null;
  }
  async storageBalance(account: string) {
    return this.data.storage?.get(account) ?? 0n;
  }
  async joinableAsset(representation: string) {
    return this.data.joinable?.get(representation) ?? null;
  }
  async settlementProgress(battleId: number) {
    return this.data.settlement?.get(battleId) ?? null;
  }
  async disposition(battleId: number) {
    return this.data.dispositions?.get(battleId) ?? null;
  }
  async releases(battleId: number) {
    return this.data.releases?.get(battleId) ?? [];
  }
  async daoSink(backing: string) {
    return this.data.sinks?.get(backing) ?? null;
  }
}
