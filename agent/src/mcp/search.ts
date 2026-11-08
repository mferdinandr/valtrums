import type { ArenaReadSource, LifecycleBattleView, ScoringMode } from "./read-source.js";

/**
 * Backend search and filtering for battle lists and dropdowns. Clients never download the whole
 * list to filter it locally: they send these parameters and receive one bounded page.
 */

export const SCORING_MODES: readonly ScoringMode[] = ["PriceGain", "MarketCapGrowth", "VolumeRatio", "LowestDrawdown"];
export const BATTLE_STATUSES = ["open", "locked", "decided"] as const;
export type BattleStatus = (typeof BATTLE_STATUSES)[number];

export const MAX_QUERY_LENGTH = 64;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
/** Upper bound of battles inspected per request, so one search cannot fan out without limit. */
export const MAX_SCAN = 200;

export interface SearchParams {
  q?: string;
  mode?: ScoringMode;
  status?: BattleStatus;
  /** NEAR representation account of a community taking part. */
  community?: string;
  /** Opaque cursor from a previous page (the next battle id to inspect, descending). */
  cursor?: string;
  limit?: number;
}

export class SearchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchValidationError";
  }
}

const ACCOUNT = /^[a-z0-9._-]{2,64}$/;

/** Validates raw string parameters (query string or tool arguments). Unknown keys are rejected. */
export function parseSearchParams(raw: Record<string, unknown>): SearchParams {
  const allowed = new Set(["q", "mode", "status", "community", "cursor", "limit"]);
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new SearchValidationError(`unknown search parameter: ${k}`);
  const out: SearchParams = {};
  const str = (k: string): string | undefined => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string" && typeof v !== "number") throw new SearchValidationError(`${k} must be a string`);
    return String(v);
  };
  const q = str("q");
  if (q !== undefined) {
    const trimmed = q.trim().toLowerCase();
    if (trimmed.length > MAX_QUERY_LENGTH) throw new SearchValidationError(`q is longer than ${MAX_QUERY_LENGTH} characters`);
    if (trimmed) out.q = trimmed;
  }
  const mode = str("mode");
  if (mode !== undefined) {
    if (!SCORING_MODES.includes(mode as ScoringMode)) throw new SearchValidationError("unknown scoring mode");
    out.mode = mode as ScoringMode;
  }
  const status = str("status");
  if (status !== undefined) {
    if (!BATTLE_STATUSES.includes(status as BattleStatus)) throw new SearchValidationError("unknown status");
    out.status = status as BattleStatus;
  }
  const community = str("community");
  if (community !== undefined) {
    if (!ACCOUNT.test(community)) throw new SearchValidationError("community must be a NEAR account id");
    out.community = community;
  }
  const cursor = str("cursor");
  if (cursor !== undefined) {
    if (!/^[1-9]\d{0,15}$/.test(cursor)) throw new SearchValidationError("malformed cursor");
    out.cursor = cursor;
  }
  const limit = str("limit");
  if (limit !== undefined) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new SearchValidationError(`limit must be 1 to ${MAX_LIMIT}`);
    out.limit = n;
  }
  return out;
}

export interface BattleSummary {
  battleId: number;
  mode: ScoringMode;
  creator: string;
  protocolCreated: boolean;
  status: BattleStatus;
  winner: number | null;
  communities: Array<{ index: number; representation: string; tokenAddress: string; chainId: string }>;
}

export interface SearchPage {
  items: BattleSummary[];
  /** Pass back as `cursor` for the next page; null at the end. */
  nextCursor: string | null;
  /** True when the scan cap stopped the search before the page filled. */
  truncated: boolean;
}

function matchesText(id: number, b: LifecycleBattleView, q: string): boolean {
  if (String(id) === q) return true;
  const fields = [b.creator, ...b.communities.flatMap((c) => [c.representation, c.token_address, c.custody_domain])];
  return fields.some((f) => f.toLowerCase().includes(q));
}

export async function searchBattles(source: ArenaReadSource, params: SearchParams): Promise<SearchPage> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  const count = await source.battleCount();
  let id = params.cursor ? Math.min(Number(params.cursor), count) : count;
  const items: BattleSummary[] = [];
  let scanned = 0;
  for (; id >= 1 && items.length < limit; id--) {
    if (scanned >= MAX_SCAN) return { items, nextCursor: String(id), truncated: true };
    scanned++;
    const b = await source.battle(id);
    if (!b) continue;
    if (params.mode && b.mode !== params.mode) continue;
    if (params.community && !b.communities.some((c) => c.representation === params.community)) continue;
    if (params.q && !matchesText(id, b, params.q)) continue;
    // The round is read only for locked battles: an open battle has no decided winner.
    const round = b.locked ? await source.round(id) : null;
    const winner = round?.winner ?? null;
    const status: BattleStatus = !b.locked ? "open" : winner === null ? "locked" : "decided";
    if (params.status && status !== params.status) continue;
    items.push({
      battleId: id,
      mode: b.mode,
      creator: b.creator,
      protocolCreated: b.protocol_created,
      status,
      winner,
      communities: b.communities.map((c, index) => ({
        index,
        representation: c.representation,
        tokenAddress: c.token_address,
        chainId: c.chain_id,
      })),
    });
  }
  return { items, nextCursor: id >= 1 ? String(id) : null, truncated: false };
}
