import { rpcView } from "./agent-grant";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface MyPosition {
  community: number;
  registered: boolean;
  /** Base units the arena holds for this account in this community. */
  amount: string;
}

/**
 * The account's position in every community of a battle, read from the arena's own `get_lifecycle_position`
 * view. Only communities where the account registered or holds an amount are returned. A receipt is never
 * used as proof here: this is what the arena reports now.
 */
export async function readMyPositions(
  rpcUrl: string, arena: string, battleId: number, account: string, communityCount: number, doFetch?: FetchLike,
): Promise<MyPosition[]> {
  const all = await Promise.all(
    Array.from({ length: communityCount }, async (_, community): Promise<MyPosition> => {
      const view = await rpcView<{ registered?: boolean; amount?: string }>(
        rpcUrl, arena, "get_lifecycle_position", { battle_id: battleId, community, account }, doFetch,
      );
      return { community, registered: view?.registered === true, amount: view?.amount ?? "0" };
    }),
  );
  return all.filter((p) => p.registered || p.amount !== "0");
}

export interface CreatorEscrow {
  creator: string;
  representation: string;
  /** Base units held in escrow until the creator's community is approved. */
  amount: string;
}

/** The creator escrow of a battle while it is held; null once converted, after a refund and for earlier battles. */
export async function readCreatorEscrow(rpcUrl: string, arena: string, battleId: number, doFetch?: FetchLike): Promise<CreatorEscrow | null> {
  const view = await rpcView<{ creator?: string; representation?: string; amount?: string }>(rpcUrl, arena, "get_lifecycle_creator_escrow", { battle_id: battleId }, doFetch);
  if (!view || typeof view.creator !== "string" || typeof view.representation !== "string" || typeof view.amount !== "string") return null;
  return { creator: view.creator, representation: view.representation, amount: view.amount };
}
