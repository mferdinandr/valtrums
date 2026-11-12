// A plan the Terminal cannot run yet, such as "vote burn 50% on that battle if I win": kept in this browser until the
// battle is settled. It holds no key and no authority; when it comes due the Terminal shows the same reviewed vote button
// as a typed request, so nothing is ever signed from here.

export interface SavedVote {
  id: string;
  account: string;
  battleId: number;
  burnPercent: number;
  createdAt: number;
}

const KEY = "valtrum:terminal:plans";
const MAX_PLANS = 20;
type Store = Pick<Storage, "getItem" | "setItem">;

const valid = (v: unknown): v is SavedVote => {
  const p = v as Partial<SavedVote> | null;
  return !!p && typeof p.id === "string" && typeof p.account === "string" && Number.isSafeInteger(p.battleId) && (p.battleId as number) > 0
    && Number.isInteger(p.burnPercent) && (p.burnPercent as number) >= 0 && (p.burnPercent as number) <= 100 && typeof p.createdAt === "number";
};

export function loadPlans(store: Store | null): SavedVote[] {
  try {
    const raw = store?.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter(valid) : [];
  } catch {
    return [];
  }
}

const write = (store: Store | null, plans: SavedVote[]) => {
  try {
    store?.setItem(KEY, JSON.stringify(plans.slice(-MAX_PLANS)));
  } catch {
    // Storage can be unavailable (private window); the plan then simply is not kept.
  }
};

/** Adds a vote plan unless the same account already has one for that battle. */
export function savePlan(store: Store | null, plan: Omit<SavedVote, "id" | "createdAt">, now = Date.now()): SavedVote[] {
  const all = loadPlans(store);
  if (all.some((p) => p.account === plan.account && p.battleId === plan.battleId)) return all;
  const next = [...all, { ...plan, id: `${plan.account}:${plan.battleId}`, createdAt: now }];
  write(store, next);
  return loadPlans(store);
}

export function removePlan(store: Store | null, id: string): SavedVote[] {
  const next = loadPlans(store).filter((p) => p.id !== id);
  write(store, next);
  return next;
}
