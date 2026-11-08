import type { SourceInfo } from "../envelope.js";
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
}
