/**
 * Player-agent strategies (OpenSpec `arena-player-agents`, "Player agent program"). A strategy only chooses which
 * community to back and how much, from on-chain battle state. It carries no authority: the user's grant on the
 * `player-policy` contract is the hard limit, and a poor strategy can at worst spend the grant's budget.
 */
export type StrategyName = "crowd" | "underdog";

export const STRATEGIES: Readonly<Record<StrategyName, { title: string; description: string }>> = {
  crowd: { title: "Follow the crowd", description: "Back the community whose vault is the largest." },
  underdog: { title: "Back the underdog", description: "Back the community whose vault is the smallest." },
};

export interface Option {
  battleId: number;
  community: number;
  /** Current vault of the community in token base units. */
  vault: bigint;
}

export interface Decision {
  battleId: number;
  community: number;
  /** Token base units as a decimal string. */
  amount: string;
  rationale: string;
}

export const isStrategyName = (v: unknown): v is StrategyName => v === "crowd" || v === "underdog";

/** The most one action may spend: the per-action cap, and a share of what is left in the budget. */
export function maxAmount(perActionCap: bigint, available: bigint, fractionBps: number): bigint {
  if (perActionCap <= 0n || available <= 0n || !Number.isInteger(fractionBps) || fractionBps < 1 || fractionBps > 10_000) return 0n;
  const share = (available * BigInt(fractionBps)) / 10_000n;
  const capped = share < perActionCap ? share : perActionCap;
  // Never zero when something is available: the smallest useful action is one base unit.
  return capped > 0n ? capped : 1n <= available && 1n <= perActionCap ? 1n : 0n;
}

/**
 * A deterministic choice. Ties are broken by the lowest battle id, then the lowest community index, so the same
 * state always gives the same answer. Returns null when there is nothing to back or nothing to spend.
 */
export function decide(name: StrategyName, options: readonly Option[], perActionCap: bigint, available: bigint, fractionBps: number): Decision | null {
  const amount = maxAmount(perActionCap, available, fractionBps);
  if (amount === 0n || options.length === 0) return null;
  const better = (a: Option, b: Option): boolean => {
    if (a.vault !== b.vault) return name === "crowd" ? a.vault > b.vault : a.vault < b.vault;
    if (a.battleId !== b.battleId) return a.battleId < b.battleId;
    return a.community < b.community;
  };
  let best = options[0]!;
  for (const o of options) if (better(o, best)) best = o;
  return {
    battleId: best.battleId,
    community: best.community,
    amount: amount.toString(),
    rationale: `${STRATEGIES[name].title}: community ${best.community + 1} of battle #${best.battleId} has a vault of ${best.vault}.`,
  };
}
