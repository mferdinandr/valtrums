// Resolving "an open arena" and "the community of this token" for the Terminal. Pure functions over what the backend
// already returned (the battle list and a battle's communities). They choose nothing silently: when more than one arena
// or community fits, the answer is a list for the user to pick from, and nothing here ever signs or sends.

import type { ApplicationBattleSummary } from "@/lib/arena-read/application";
import type { LifecycleIntent } from "./lifecycle-intent";

export interface OpenArena {
  battleId: number;
  mode: string;
  startAtMs: number;
  /** Display symbols of its communities (a display name only; identity stays the representation). */
  symbols: string[];
  /** The raw communities, for matching a token the user named. */
  communities: ApplicationBattleSummary["communities"];
}

const norm = (v: string): string => v.trim().replace(/^\$/, "").toLowerCase();

/** Arenas that still accept communities: open, not cancelled, with a start time that has not passed. */
export function openArenasOf(items: readonly ApplicationBattleSummary[], nowMs: number): OpenArena[] {
  return items
    .filter((b) => b.status === "open" && !b.cancelled && b.startAtMs !== null && /^[1-9][0-9]{0,18}$/.test(b.startAtMs) && Number(b.startAtMs) > nowMs)
    .map((b) => ({
      battleId: Number(b.battleId),
      mode: b.mode,
      startAtMs: Number(b.startAtMs),
      symbols: b.communities.map((c) => c.label?.symbol ?? "token"),
      communities: b.communities,
    }))
    .filter((a) => Number.isSafeInteger(a.battleId) && a.battleId > 0)
    .sort((a, b) => a.startAtMs - b.startAtMs);
}

/** The plain name of a token as a person writes it: the label's symbol or name, with a testnet mock's "m" / "Mock " prefix dropped. */
function namesOf(c: { representation: string; label: { symbol: string; name: string; kind?: string } | null }): string[] {
  const out = [norm(c.representation), norm(c.representation.replace(/^backing-/, "").split(".")[0] ?? "")];
  if (c.label) {
    const symbol = norm(c.label.symbol);
    const name = norm(c.label.name);
    out.push(symbol, name);
    // The testnet mocks are labelled "mCASHCAT" / "Mock CASHCAT", but people say CASHCAT.
    if (c.label.kind === "testnet-mock" || /^mock /.test(name)) {
      if (/^m[a-z0-9]/.test(symbol)) out.push(symbol.slice(1));
      if (name.startsWith("mock ")) out.push(name.slice(5));
    }
  }
  return out.filter(Boolean);
}

/** A token the user wrote ("cashcat", "$CASHCAT", "Mock CASHCAT", "mCASHCAT", or the NEAR representation) against one community. */
export function matchesToken(ref: string, c: { representation: string; label: { symbol: string; name: string; kind?: string } | null }): boolean {
  const wanted = norm(ref);
  return wanted !== "" && namesOf(c).includes(wanted);
}

export type ArenaChoice =
  | { kind: "one"; arena: OpenArena; why: string }
  | { kind: "many"; arenas: OpenArena[]; why: string }
  | { kind: "none"; message: string; /** Open arenas that exist but do not have the token yet, for "join one with it". */ joinable: OpenArena[] };

/**
 * Which open arenas fit the intent. A deposit that names a token prefers arenas that already have a community of that
 * token; if none has, every open arena fits, because the deposit adds the community itself. Never picks among several.
 */
export function chooseArena(intent: Extract<LifecycleIntent, { kind: "join_battle" | "register_position" | "deposit" }>, arenas: readonly OpenArena[]): ArenaChoice {
  if (arenas.length === 0) return { kind: "none", message: "There is no open arena right now. Arenas accept communities until their start time.", joinable: [] };
  if (intent.kind === "deposit" && intent.tokenRef !== null) {
    const ref = intent.tokenRef;
    const fits = arenas.filter((a) => a.communities.some((c) => matchesToken(ref, c)));
    if (fits.length === 0) {
      // No arena has the token yet: the deposit adds it as a community first (join, approval, deposit in one flow).
      return arenas.length === 1
        ? { kind: "one", arena: arenas[0]!, why: `the only open arena; ${ref} will be added to it` }
        : { kind: "many", arenas: [...arenas], why: `${arenas.length} arenas are open and none has a ${ref} community yet (it will be added)` };
    }
    return fits.length === 1 ? { kind: "one", arena: fits[0]!, why: `the only open arena with a ${ref} community` } : { kind: "many", arenas: fits, why: `${fits.length} open arenas have a ${ref} community` };
  }
  return arenas.length === 1 ? { kind: "one", arena: arenas[0]!, why: "the only open arena" } : { kind: "many", arenas: [...arenas], why: `${arenas.length} arenas are open` };
}

export type CommunityChoice = { kind: "one"; index: number } | { kind: "none" } | { kind: "many"; indexes: number[] };

/** The community of a battle that holds the named token. Several matches are returned for the user to pick, never guessed. */
export function communityForToken(ref: string, communities: ReadonlyArray<{ representation: string; label: { symbol: string; name: string; kind?: string } | null }>): CommunityChoice {
  const hits = communities.flatMap((c, i) => (matchesToken(ref, c) ? [i] : []));
  if (hits.length === 0) return { kind: "none" };
  return hits.length === 1 ? { kind: "one", index: hits[0]! } : { kind: "many", indexes: hits };
}
