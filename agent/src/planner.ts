import { type ArenaClient, fetchAllBattles } from "./client.js";
import type { BattleView } from "./types.js";

export type WorkItem =
  | { kind: "audit"; battleId: number }
  | { kind: "set_initial_prices"; battleId: number }
  | { kind: "settle"; battleId: number };

/**
 * Decide which actions are due from battle state and the current chain time.
 * Pure function of its inputs: nothing is remembered between calls, so a
 * restarted agent derives exactly the same plan and, once an action has landed
 * on-chain (status change), the item disappears from the plan.
 */
export function planWork(battles: readonly BattleView[], nowNs: bigint): WorkItem[] {
  const work: WorkItem[] = [];
  for (const b of battles) {
    switch (b.status) {
      case "Proposed":
        work.push({ kind: "audit", battleId: b.id });
        break;
      case "Approved":
        if (nowNs >= BigInt(b.deposit_deadline_ns)) {
          work.push({ kind: "set_initial_prices", battleId: b.id });
        }
        break;
      case "Live":
        if (nowNs >= BigInt(b.end_time_ns)) {
          work.push({ kind: "settle", battleId: b.id });
        }
        break;
      default:
        break;
    }
  }
  return work;
}

/** Read all battles from chain and plan. `nowNs` is injectable for tests. */
export async function planFromChain(
  client: ArenaClient,
  nowNs: bigint = BigInt(Date.now()) * 1_000_000n,
): Promise<WorkItem[]> {
  return planWork(await fetchAllBattles(client), nowNs);
}
