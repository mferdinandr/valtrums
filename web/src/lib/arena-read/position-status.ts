import { rpcView } from "./agent-grant";

/**
 * Where a battle is, for grouping the portfolio's positions: still open for deposits, live (locked, a winner not
 * recorded yet), finished (a winner is recorded) or cancelled. Read from the arena's own `get_lifecycle_battle`.
 */
export type BattleStage = "open" | "live" | "finished" | "cancelled";

export interface BattleBrief {
  stage: BattleStage;
  /** The community that won, when a final winner is recorded. */
  winner: number | null;
}

interface BattleView {
  locked?: boolean;
  cancelled?: boolean;
  principal_community?: number | null;
}

export function briefOf(v: BattleView | null | undefined): BattleBrief | null {
  if (!v) return null;
  const winner = typeof v.principal_community === "number" ? v.principal_community : null;
  if (v.cancelled === true) return { stage: "cancelled", winner: null };
  if (winner !== null) return { stage: "finished", winner };
  return { stage: v.locked ? "live" : "open", winner: null };
}

/** The stage of each battle id; a battle that cannot be read is left out rather than guessed. */
export async function readBattleBriefs(rpcUrl: string, arena: string, ids: readonly number[]): Promise<Map<number, BattleBrief>> {
  const out = new Map<number, BattleBrief>();
  await Promise.all(
    ids.map(async (id) => {
      const brief = briefOf(await rpcView<BattleView>(rpcUrl, arena, "get_lifecycle_battle", { battle_id: id }).catch(() => null));
      if (brief) out.set(id, brief);
    }),
  );
  return out;
}

export const STAGE_ORDER: readonly BattleStage[] = ["open", "live", "finished", "cancelled"];
export const STAGE_TITLE: Record<BattleStage, string> = { open: "Open", live: "Live", finished: "Finished", cancelled: "Cancelled" };
