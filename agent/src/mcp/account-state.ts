import { readFile, stat } from "node:fs/promises";
import type { IndexerHealthView, LedgerView, SuspensionView } from "./alerts.js";
import type { SourceInfo } from "./envelope.js";
import { PAYOUT_DISPLAY_LABELS, type PayoutDisplayState, payoutDisplayState } from "./payout-display.js";
import type { ArenaReadSource, LifecycleBattleView, PayoutView, ViewFn } from "./read-source.js";

/**
 * Account state for display (#79): entitlements, transfers and DAO principal are reported as
 * three separate lists, each item with its source and observation time. An entitlement is not a
 * transfer, a transfer is not paid until its receipt is confirmed, and escrowed principal is
 * neither: it follows the D22 vote, and a burn counts only once its sink transfer is confirmed.
 */

/** `arena.get_lifecycle_disposition` (subset). */
export interface DispositionView {
  status: "no_winner" | "no_vote" | "voting" | "undecided_escrowed" | "decided";
  closes_at_ns: string | null;
  burn_weight: string;
  return_weight: string;
  escrow_reserved: boolean;
  escrow_id: string | null;
}

/** `arena.get_lifecycle_disposition_releases` item. */
export interface ReleaseView {
  id: string;
  kind: "return" | "burn";
  beneficiary: string | null;
  amount: string;
  recorded: boolean;
}

/** `backing.get_escrow_disposition`. */
export interface EscrowDispositionView {
  escrowed: string;
  returned: string;
  burn_pending: string;
  burn_confirmed: string;
  still_escrowed: string;
}

/** Read-only state for the account view and the alerts; nothing here signs or sends. */
export interface StateSource {
  readonly info: SourceInfo;
  entitlement(backing: string, account: string): Promise<string>;
  disposition(battleId: number): Promise<DispositionView | null>;
  releases(battleId: number): Promise<ReleaseView[]>;
  escrowDisposition(backing: string, escrowIdHex: string): Promise<EscrowDispositionView | null>;
  suspension(backing: string): Promise<SuspensionView | null>;
  ledger(backing: string): Promise<LedgerView | null>;
  indexerHealth(): Promise<IndexerHealthView | null>;
}

export class NearStateSource implements StateSource {
  constructor(
    readonly info: SourceInfo,
    private readonly view: ViewFn,
    private readonly arena: string,
    /** Indexer state directory (`state.json`), read-only; unset = no indexer health. */
    private readonly indexerStateDir: string | null,
  ) {}
  async entitlement(backing: string, account: string): Promise<string> {
    return String(await this.view(backing, "entitlement_of", { account }));
  }
  async disposition(battleId: number): Promise<DispositionView | null> {
    return ((await this.view(this.arena, "get_lifecycle_disposition", { battle_id: String(battleId) })) ?? null) as DispositionView | null;
  }
  async releases(battleId: number): Promise<ReleaseView[]> {
    return ((await this.view(this.arena, "get_lifecycle_disposition_releases", { battle_id: String(battleId) })) ?? []) as ReleaseView[];
  }
  async escrowDisposition(backing: string, escrowIdHex: string): Promise<EscrowDispositionView | null> {
    return ((await this.view(backing, "get_escrow_disposition", { escrow_id: Array.from(Buffer.from(escrowIdHex, "hex")) })) ??
      null) as EscrowDispositionView | null;
  }
  async suspension(backing: string): Promise<SuspensionView | null> {
    return ((await this.view(backing, "get_suspension", {})) ?? null) as SuspensionView | null;
  }
  async ledger(backing: string): Promise<LedgerView | null> {
    return ((await this.view(backing, "get_ledger", {})) ?? null) as LedgerView | null;
  }
  async indexerHealth(): Promise<IndexerHealthView | null> {
    if (!this.indexerStateDir) return null;
    try {
      const path = `${this.indexerStateDir}/state.json`;
      const state = JSON.parse(await readFile(path, "utf8")) as { health?: { status: IndexerHealthView["status"]; reason: string } };
      if (!state.health) return { status: "degraded", reason: "indexer state has no health record", lastSyncMs: null };
      // The state file is rewritten on every committed sync, so its mtime is the last sync time.
      return { status: state.health.status, reason: state.health.reason, lastSyncMs: (await stat(path)).mtimeMs };
    } catch {
      // Unreadable or missing state is reported as unknown health, never as healthy.
      return { status: "degraded", reason: "indexer state is missing or unreadable", lastSyncMs: null };
    }
  }
}

/** In-memory source for tests and demos; `info.kind` is always `fixture`. */
export class FixtureStateSource implements StateSource {
  readonly info: SourceInfo;
  constructor(
    network: string,
    readonly data: {
      entitlements?: Map<string, string>;
      dispositions?: Map<number, DispositionView>;
      releases?: Map<number, ReleaseView[]>;
      escrows?: Map<string, EscrowDispositionView>;
      suspensions?: Map<string, SuspensionView>;
      ledgers?: Map<string, LedgerView>;
      indexer?: IndexerHealthView | null;
    },
  ) {
    this.info = { network, kind: "fixture", name: "fixture-state" };
  }
  async entitlement(backing: string, account: string) {
    return this.data.entitlements?.get(`${backing}|${account}`) ?? "0";
  }
  async disposition(battleId: number) {
    return this.data.dispositions?.get(battleId) ?? null;
  }
  async releases(battleId: number) {
    return this.data.releases?.get(battleId) ?? [];
  }
  async escrowDisposition(backing: string, escrowIdHex: string) {
    return this.data.escrows?.get(`${backing}|${escrowIdHex}`) ?? null;
  }
  async suspension(backing: string) {
    return this.data.suspensions?.get(backing) ?? null;
  }
  async ledger(backing: string) {
    return this.data.ledgers?.get(backing) ?? null;
  }
  async indexerHealth() {
    return this.data.indexer ?? null;
  }
}

export interface Sourced {
  source: { kind: SourceInfo["kind"]; name: string };
  observedAt: string;
}

export interface AccountState {
  accountId: string;
  /** Asset-bound entitlements in each backing: claimable, not yet requested for payout. */
  entitlements: (Sourced & { backing: string; available: string })[];
  /** Payout transfers by display stage; only `confirmed` is a verified receipt. */
  transfers: (Sourced & { backing: string; amount: string; state: string; displayState: PayoutDisplayState; label: string })[];
  /** Winning principal in DAO escrow, with the vote and the source-chain disposition. */
  daoPrincipal: (Sourced & {
    battleId: number;
    community: number;
    position: string;
    voteStatus: DispositionView["status"] | "unknown";
    voteClosesAtNs: string | null;
    myReturn: { amount: string; recorded: boolean } | null;
    escrow: EscrowDispositionView | null;
  })[];
}

/** Backings the account touches: every community representation of the given battles. */
export function backingsOf(battles: LifecycleBattleView[]): string[] {
  return [...new Set(battles.flatMap((b) => b.communities.map((c) => c.representation)))];
}

export async function buildAccountState(
  account: string,
  battles: { battleId: number; battle: LifecycleBattleView }[],
  arena: ArenaReadSource,
  state: StateSource,
  payouts: PayoutView[],
  nowMs: number,
): Promise<AccountState> {
  const stamp = (info: SourceInfo): Sourced => ({ source: { kind: info.kind, name: info.name }, observedAt: new Date(nowMs).toISOString() });
  const entitlements: AccountState["entitlements"] = [];
  for (const backing of backingsOf(battles.map((b) => b.battle))) {
    const available = await state.entitlement(backing, account);
    if (available !== "0") entitlements.push({ ...stamp(state.info), backing, available });
  }
  const transfers = payouts
    .filter((p) => p.holder === account)
    .map((p) => {
      const displayState = payoutDisplayState(p.state);
      return { ...stamp(arena.info), backing: p.backing, amount: p.amount, state: p.state, displayState, label: PAYOUT_DISPLAY_LABELS[displayState] };
    });
  const daoPrincipal: AccountState["daoPrincipal"] = [];
  for (const { battleId, battle } of battles) {
    if (battle.principal_community === null) continue;
    const position = await arena.position(battleId, battle.principal_community, account);
    if (!position.registered || position.amount === "0") continue;
    const disposition = await state.disposition(battleId);
    const mine = (await state.releases(battleId)).find((r) => r.kind === "return" && r.beneficiary === account) ?? null;
    const backing = battle.communities[battle.principal_community]?.representation;
    const escrow = backing && disposition?.escrow_id ? await state.escrowDisposition(backing, disposition.escrow_id) : null;
    daoPrincipal.push({
      ...stamp(state.info),
      battleId,
      community: battle.principal_community,
      position: position.amount,
      voteStatus: disposition?.status ?? "unknown",
      voteClosesAtNs: disposition?.closes_at_ns ?? null,
      myReturn: mine ? { amount: mine.amount, recorded: mine.recorded } : null,
      escrow,
    });
  }
  return { accountId: account, entitlements, transfers, daoPrincipal };
}
