/** Reference arithmetic and policy model for the planned arena.
 * Caller identities/bindings must be authenticated by the trusted contract layer.
 * This module is NOT on-chain authorization or a payout executor.
 */
const BPS = 10_000n;
const U128_MAX = (1n << 128n) - 1n;

export interface RevenuePolicy {
  readonly version: bigint;
  readonly totalFeeBps: number;
  readonly creatorShareBps: number;
}
export interface RevenuePolicyUpdate {
  readonly actor: string;
  readonly previous: RevenuePolicy;
  readonly current: RevenuePolicy;
}
export interface BattleRevenueSnapshot extends RevenuePolicy {
  readonly creator: string;
  readonly protocolCreated: boolean;
  readonly creatorRecipient: string;
  readonly protocolRecipient: string;
}
export interface WinnerDeposit { readonly accountId: string; readonly units: bigint }
export interface LosingVault { readonly assetId: string; readonly units: bigint }
export interface WinnerReward { readonly accountId: string; readonly units: bigint }
export interface VaultAllocation {
  readonly assetId: string;
  readonly vaultUnits: bigint;
  readonly feeUnits: bigint;
  readonly creatorFeeUnits: bigint;
  readonly protocolFeeUnits: bigint;
  readonly winnerPoolUnits: bigint;
  readonly creatorRecipient: string;
  readonly protocolRecipient: string;
  readonly rewards: readonly WinnerReward[];
}

function account(value: string): void {
  // Canonical NEAR account IDs are ASCII; lexical ordering is byte ordering.
  if (typeof value !== "string" || value.length < 2 || value.length > 64 ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)) throw new Error("invalid canonical account ID");
}
function recipient(value: string): void {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value) || /^0x0{40}$/.test(value)) {
    throw new Error("recipient must be a canonical nonzero Robinhood EVM address");
  }
}
function basisPoints(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error("basis points outside [0, 10000]");
}
function units(value: bigint): void {
  if (typeof value !== "bigint" || value < 0n || value > U128_MAX) throw new Error("units outside u128 range");
}

/** All callers are assumed authenticated externally, like predecessor_account_id. */
export class RevenuePolicyRegistry {
  readonly #authority: string;
  readonly #protocolRecipient: string;
  readonly #creators = new Set<string>();
  readonly #bindings = new Map<string, string>();
  #policy: RevenuePolicy = Object.freeze({ version: 1n, totalFeeBps: 10, creatorShareBps: 5000 });

  constructor(authority: string, protocolRecipient: string) {
    account(authority); recipient(protocolRecipient);
    this.#authority = authority; this.#protocolRecipient = protocolRecipient;
    this.#creators.add(authority);
  }
  get policy(): RevenuePolicy { return this.#policy; }
  update(caller: string, totalFeeBps: number, creatorShareBps: number): RevenuePolicyUpdate {
    this.#authorize(caller); basisPoints(totalFeeBps); basisPoints(creatorShareBps);
    const previous = this.#policy;
    const current = Object.freeze({ version: previous.version + 1n, totalFeeBps, creatorShareBps });
    this.#policy = current;
    return Object.freeze({ actor: caller, previous, current });
  }
  setProtocolCreator(caller: string, creator: string, enabled: boolean): void {
    this.#authorize(caller); account(creator);
    if (typeof enabled !== "boolean") throw new Error("invalid protocol creator status");
    if (enabled) this.#creators.add(creator); else this.#creators.delete(creator);
  }
  /** User-authenticated destination binding; never accept model-provided identity. */
  bindRecipient(caller: string, address: string): void {
    account(caller); recipient(address); this.#bindings.set(caller, address);
  }
  /** Call exactly at battle creation; later binding/policy changes cannot alter it. */
  snapshotAtCreation(caller: string, claimsProtocolCreator: boolean): BattleRevenueSnapshot {
    account(caller);
    const protocolCreated = this.#creators.has(caller);
    if (claimsProtocolCreator !== protocolCreated) throw new Error("protocol creator identity mismatch");
    const creatorRecipient = this.#bindings.get(caller);
    if (!creatorRecipient) throw new Error("creator recipient binding missing");
    return Object.freeze({ ...this.#policy, creator: caller, protocolCreated,
      creatorRecipient, protocolRecipient: this.#protocolRecipient });
  }
  #authorize(caller: string): void {
    if (caller !== this.#authority) throw new Error("protocol authority required");
  }
}

function rewardShares(pool: bigint, deposits: readonly WinnerDeposit[]): readonly WinnerReward[] {
  const weights = new Map<string, bigint>();
  for (const deposit of deposits) {
    account(deposit.accountId); units(deposit.units);
    if (deposit.units === 0n) throw new Error("winning deposit must be positive");
    const combined = (weights.get(deposit.accountId) ?? 0n) + deposit.units;
    units(combined); weights.set(deposit.accountId, combined);
  }
  const total = [...weights.values()].reduce((sum, value) => sum + value, 0n);
  units(total);
  if (total === 0n) throw new Error("winner vault must be nonempty");
  const entries = [...weights.entries()].map(([accountId, weight]) => ({
    accountId, units: pool * weight / total, remainder: pool * weight % total,
  }));
  entries.sort((a, b) => a.remainder === b.remainder ? compareAccounts(a.accountId, b.accountId) :
    a.remainder > b.remainder ? -1 : 1);
  const remaining = pool - entries.reduce((sum, entry) => sum + entry.units, 0n);
  // Largest remainder guarantees remaining < beneficiary count; no numeric amount conversion.
  for (let i = 0; BigInt(i) < remaining; i++) entries[i]!.units += 1n;
  entries.sort((a, b) => compareAccounts(a.accountId, b.accountId));
  return Object.freeze(entries.map(({ accountId, units: amount }) => Object.freeze({ accountId, units: amount })));
}
function compareAccounts(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export function allocateLosingVaults(
  snapshot: BattleRevenueSnapshot, vaults: readonly LosingVault[], deposits: readonly WinnerDeposit[],
): readonly VaultAllocation[] {
  basisPoints(snapshot.totalFeeBps); basisPoints(snapshot.creatorShareBps);
  account(snapshot.creator); recipient(snapshot.creatorRecipient); recipient(snapshot.protocolRecipient);
  if (typeof snapshot.version !== "bigint" || snapshot.version < 1n || typeof snapshot.protocolCreated !== "boolean") {
    throw new Error("invalid revenue snapshot");
  }
  const seen = new Set<string>();
  return Object.freeze(vaults.map(vault => {
    if (typeof vault.assetId !== "string" || !vault.assetId || vault.assetId.trim() !== vault.assetId || seen.has(vault.assetId)) {
      throw new Error("duplicate or missing losing asset identity");
    }
    seen.add(vault.assetId); units(vault.units);
    const feeUnits = vault.units * BigInt(snapshot.totalFeeBps) / BPS;
    const winnerPoolUnits = vault.units - feeUnits;
    const creatorFeeUnits = snapshot.protocolCreated ? 0n : feeUnits * BigInt(snapshot.creatorShareBps) / BPS;
    const protocolFeeUnits = feeUnits - creatorFeeUnits;
    return Object.freeze({ assetId: vault.assetId, vaultUnits: vault.units, feeUnits,
      creatorFeeUnits, protocolFeeUnits, winnerPoolUnits,
      creatorRecipient: snapshot.creatorRecipient, protocolRecipient: snapshot.protocolRecipient,
      rewards: rewardShares(winnerPoolUnits, deposits) });
  }));
}
