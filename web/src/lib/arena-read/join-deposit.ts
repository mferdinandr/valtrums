import { rpcView } from "./agent-grant";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Where a token stands in an open battle: whether it is already one of its communities (and which one) and
 * whether the community has both approvals, which a deposit needs. Reads only what the arena reports now.
 */
export interface CommunityState {
  /** Index of the community, or null while the token has not been added to the battle. */
  index: number | null;
  /** True once the arena holds both an audit approval and a backing approval for the community. */
  approved: boolean;
}

export async function readCommunityState(
  rpcUrl: string, arena: string, battleId: number, representation: string, doFetch?: FetchLike,
): Promise<CommunityState> {
  const battle = await rpcView<{ communities?: Array<{ representation?: string; audit_evidence_hash?: string | null; backing_evidence_hash?: string | null }> }>(
    rpcUrl, arena, "get_lifecycle_battle", { battle_id: battleId }, doFetch,
  );
  const communities = battle?.communities ?? [];
  const index = communities.findIndex((c) => c.representation === representation);
  if (index < 0) return { index: null, approved: false };
  const c = communities[index]!;
  return { index, approved: !!c.audit_evidence_hash && !!c.backing_evidence_hash };
}

/** Whether `account` already registered a position in the community, so a join would only repeat itself. */
export async function readRegistered(
  rpcUrl: string, arena: string, battleId: number, community: number, account: string, doFetch?: FetchLike,
): Promise<boolean> {
  const view = await rpcView<{ registered?: boolean }>(rpcUrl, arena, "get_lifecycle_position", { battle_id: battleId, community, account }, doFetch);
  return view?.registered === true;
}
