import type { SourceInfo } from "./envelope.js";

/** JSON shapes of the deployed arena and payout views (u64/u128 arrive as decimal strings). */
export type ScoringMode = "PriceGain" | "MarketCapGrowth" | "VolumeRatio" | "LowestDrawdown";

export interface CommunityView {
  chain_id: string;
  token_address: string;
  representation: string;
  custody_domain: string;
  reference_chain_id: string | null;
  reference_address: string | null;
  vault: string;
  audit_policy_hash: string | null;
  audit_evidence_hash: string | null;
  audit_expires_at_ms: string | null;
  backing_evidence_hash: string | null;
}

export interface LifecycleBattleView {
  creator: string;
  protocol: string;
  protocol_created: boolean;
  fee_bps: number;
  creator_share_bps: number;
  mode: ScoringMode;
  communities: CommunityView[];
  locked: boolean;
  observation_policy_version: string | null;
  observation_policy_hash: string | null;
  principal_community: number | null;
  principal_amount: string | null;
}

export interface RoundView {
  round_id: string;
  candidates: number[];
  start_ns: string | null;
  end_ns: string | null;
  winner: number | null;
}

export interface PositionView {
  registered: boolean;
  amount: string;
}

export type PayoutState =
  | "Authorized"
  | "SigningRequested"
  | "Signed"
  | "Broadcast"
  | "PendingFinality"
  | "Reverted"
  | "ReconciliationRequired"
  | "Confirmed"
  | "Restored";

export interface PayoutView {
  backing: string;
  holder: string;
  request_id: number[] | string;
  state: PayoutState;
  terminal: boolean;
  chain_id: string;
  amount: string;
  attempts: unknown[];
  evidence_hash: unknown | null;
}

/**
 * Read-only access to arena state. The interface has no method that signs, sends or reserves
 * anything; a tool handed this source cannot spend by construction.
 */
export interface ArenaReadSource {
  readonly info: SourceInfo;
  battleCount(): Promise<number>;
  battle(battleId: number): Promise<LifecycleBattleView | null>;
  round(battleId: number): Promise<RoundView | null>;
  position(battleId: number, community: number, account: string): Promise<PositionView>;
  /** Unresolved payouts (terminal ones are not listed by the contract). */
  openPayouts(fromIndex: number, limit: number): Promise<{ items: PayoutView[]; nextIndex: number }>;
}

/** A NEAR `view` call. Nothing else is reachable from this source. */
export type ViewFn = (contractId: string, method: string, args: Record<string, unknown>) => Promise<unknown>;

export class UnsafeReadBoundaryError extends Error {}

export class NearArenaReadSource implements ArenaReadSource {
  constructor(
    readonly info: SourceInfo,
    private readonly view: ViewFn,
    private readonly contracts: { arena: string; payout: string | null },
  ) {}

  async battleCount(): Promise<number> {
    const raw = await this.view(this.contracts.arena, "get_lifecycle_battle_count", {});
    if ((typeof raw !== "number" && typeof raw !== "string") || (typeof raw === "string" && !/^(0|[1-9][0-9]*)$/.test(raw))) {
      throw new UnsafeReadBoundaryError("bad lifecycle battle count");
    }
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0) throw new UnsafeReadBoundaryError("bad lifecycle battle count");
    return n;
  }

  async battle(battleId: number): Promise<LifecycleBattleView | null> {
    return ((await this.view(this.contracts.arena, "get_lifecycle_battle", { battle_id: battleId })) ??
      null) as LifecycleBattleView | null;
  }

  async round(battleId: number): Promise<RoundView | null> {
    return ((await this.view(this.contracts.arena, "get_lifecycle_round", { battle_id: String(battleId) })) ??
      null) as RoundView | null;
  }

  async position(battleId: number, community: number, account: string): Promise<PositionView> {
    return (await this.view(this.contracts.arena, "get_lifecycle_position", {
      battle_id: battleId,
      community,
      account,
    })) as PositionView;
  }

  async openPayouts(fromIndex: number, limit: number): Promise<{ items: PayoutView[]; nextIndex: number }> {
    if (!this.contracts.payout) return { items: [], nextIndex: fromIndex };
    const page = (await this.view(this.contracts.payout, "list_open_payouts", {
      from_index: String(fromIndex),
      limit: String(limit),
    })) as { items?: PayoutView[]; next_index?: string } | null;
    return { items: page?.items ?? [], nextIndex: Number(page?.next_index ?? fromIndex) };
  }
}

/** In-memory source for demos and tests. Its `info.kind` is always `fixture`. */
export class FixtureArenaReadSource implements ArenaReadSource {
  readonly info: SourceInfo;
  constructor(
    network: string,
    private readonly data: {
      battles: Map<number, LifecycleBattleView>;
      rounds?: Map<number, RoundView>;
      positions?: Map<string, PositionView>;
      payouts?: PayoutView[];
    },
  ) {
    this.info = { network, kind: "fixture", name: "fixture-arena" };
  }

  static positionKey(battleId: number, community: number, account: string): string {
    return `${battleId}:${community}:${account}`;
  }

  async battleCount(): Promise<number> {
    return this.data.battles.size === 0 ? 0 : Math.max(...this.data.battles.keys());
  }
  async battle(battleId: number): Promise<LifecycleBattleView | null> {
    return this.data.battles.get(battleId) ?? null;
  }
  async round(battleId: number): Promise<RoundView | null> {
    return this.data.rounds?.get(battleId) ?? null;
  }
  async position(battleId: number, community: number, account: string): Promise<PositionView> {
    return (
      this.data.positions?.get(FixtureArenaReadSource.positionKey(battleId, community, account)) ?? {
        registered: false,
        amount: "0",
      }
    );
  }
  async openPayouts(fromIndex: number, limit: number): Promise<{ items: PayoutView[]; nextIndex: number }> {
    const all = this.data.payouts ?? [];
    const end = Math.min(all.length, fromIndex + limit);
    return { items: all.slice(fromIndex, end).filter((p) => !p.terminal), nextIndex: end };
  }
}
