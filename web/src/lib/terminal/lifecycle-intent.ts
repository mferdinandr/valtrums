// Lifecycle terminal intents: strict validation of untrusted parser output and the mapping to action requests.
// Field rules mirror `validateRequest` in agent/src/mcp/actions/preview.ts. A parser (rules or model) only PROPOSES
// an intent: it never supplies an address, never authorizes and never reaches the wallet. Token addresses come from
// the backend asset registry after resolution (`lifecycle-resolve.ts`), receivers from the battle read.

import { registerRequest, depositRequest } from "@/lib/arena-read/deposit-flow";
import { SCORING_MODES } from "@/lib/arena-read/create-review";
import { cancelRequest, joinRequest, refundRequest } from "@/lib/arena-read/open-arena";
import type { ScoringMode } from "@/lib/arena-read/lifecycle";
import { formatUnits } from "@/lib/amounts";

/** Sixteen full 0x addresses are about 700 characters, so the limit leaves room for a maximal create prompt. */
export const MAX_PROMPT_CHARS = 1200;
export const MAX_ASSET_REF_CHARS = 80;
/** Users count communities from 1 (as the UI labels them); intents store the contract's 0-based index. */
export const MAX_COMMUNITY_NUMBER = 16;
/** The arena's start window in whole minutes: 1 minute to 7 days (D34). */
export const MIN_START_MINUTES = 1;
export const MAX_START_MINUTES = 7 * 24 * 60;

const AMOUNT = /^[1-9][0-9]{0,38}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;

/** Tokens have 18 decimals on every representation the arena allows. */
export const TOKEN_DECIMALS = 18;
/** Plain token amount as a person writes it ("100", "0.5"); never a sign, separator or exponent. */
const TOKEN_AMOUNT = /^(0|[1-9][0-9]{0,20})(\.[0-9]{1,18})?$/;

export type LifecycleIntent =
  /** An open arena (D34): no communities; the exact start time is fixed when the review is built. */
  | { kind: "create_battle"; mode: ScoringMode; startInMinutes: number }
  /**
   * `tokenRef` is what the user wrote; it is resolved against the arena's allowlist before any review exists.
   * `battleId: null` means "an open arena": the terminal resolves it from the battle list and asks when more than one fits.
   */
  | { kind: "join_battle"; battleId: number | null; tokenRef: string }
  | { kind: "cancel_battle"; battleId: number }
  | { kind: "claim_refund"; battleId: number; community: number }
  | { kind: "register_position"; battleId: number | null; community: number }
  /**
   * The community is a 0-based index, or `null` with a `tokenRef` naming the token of the community to back (resolved
   * against the battle's own communities). `amount` is always base units here: a plain token amount is converted once,
   * by code, when the intent is validated.
   */
  | { kind: "deposit"; battleId: number | null; community: number | null; tokenRef: string | null; amount: string }
  | { kind: "payout"; backing: string; amount: string; destination: string }
  /** Read-only questions. They never build a request and never sign. */
  | { kind: "list_battles"; status: "open" | "all" }
  | { kind: "show_positions" };

export type LifecycleParseResult =
  | { ok: true; intent: LifecycleIntent; /** Which parser understood it: "near-ai" or "rules". */ via?: string; /** Why a fallback was used, when one was. */ note?: string }
  | { ok: false; error: string; /** Set when the user should be asked a follow-up question. */ clarify?: boolean; via?: string; note?: string };

/** A parser never throws; every failure is a result. */
export interface LifecycleIntentParser {
  readonly name: string;
  parse(prompt: string): Promise<LifecycleParseResult>;
}

/** Wire shape the model and the route use. `communityNumber` is 1-based; everything else is the intent. */
export const LIFECYCLE_INTENT_JSON_SCHEMA = {
  oneOf: [
    { kind: "create_battle", mode: "PriceGain|MarketCapGrowth|VolumeRatio|LowestDrawdown", startInMinutes: "whole minutes from now until the start, 1 to 10080" },
    { kind: "join_battle", battleId: "positive integer, or omit it and set battle to \"open\" when the user does not name a battle", battle: "\"open\" (optional)", tokenRef: "the token exactly as the user wrote it (never invent an address)" },
    { kind: "cancel_battle", battleId: "positive integer" },
    { kind: "claim_refund", battleId: "positive integer", communityNumber: "1 to 16" },
    { kind: "register_position", battleId: "positive integer, or battle \"open\"", battle: "\"open\" (optional)", communityNumber: "1 to 16" },
    { kind: "deposit", battleId: "positive integer, or battle \"open\"", battle: "\"open\" (optional)", communityNumber: "1 to 16, or give tokenRef instead", tokenRef: "the token of the community to back, as the user wrote it (optional)", amountTokens: "the amount in tokens exactly as the user wrote it, digits with an optional dot, for example 100 or 0.5; the code converts it" },
    { kind: "payout", backing: "NEAR account id", amount: "digits only, positive integer", destination: "0x + 40 hex" },
    { kind: "list_battles", status: "open|all (which battles the user asks about)" },
    { kind: "show_positions" },
  ],
} as const;

const fail = (error: string): LifecycleParseResult => ({ ok: false, error });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const FIELDS: Record<string, readonly string[]> = {
  create_battle: ["kind", "mode", "startInMinutes"],
  join_battle: ["kind", "battleId", "battle", "tokenRef"],
  cancel_battle: ["kind", "battleId"],
  claim_refund: ["kind", "battleId", "communityNumber"],
  register_position: ["kind", "battleId", "battle", "communityNumber"],
  deposit: ["kind", "battleId", "battle", "communityNumber", "tokenRef", "amount", "amountTokens"],
  payout: ["kind", "backing", "amount", "destination"],
  list_battles: ["kind", "status"],
  show_positions: ["kind"],
};

/**
 * A plain token amount ("100", "0.5") as base units, by exact integer arithmetic. Null when it is not a positive
 * amount with at most 18 decimals, so no model or prompt text ever does arithmetic on money.
 */
export function tokensToBaseUnits(text: string): string | null {
  if (!TOKEN_AMOUNT.test(text)) return null;
  const [whole = "0", frac = ""] = text.split(".");
  const base = BigInt(whole) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt(frac.padEnd(TOKEN_DECIMALS, "0") || "0");
  const out = base.toString();
  return base > 0n && AMOUNT.test(out) ? out : null;
}

/** `battle: "open"` (an open arena) or a battle id. Both, or any other word, is refused. */
function battleRefOf(raw: Record<string, unknown>): { ok: true; battleId: number | null } | { ok: false; error: string } {
  if (raw.battle !== undefined) {
    if (raw.battle !== "open") return { ok: false, error: 'The battle reference must be a battle id or "open"' };
    if (raw.battleId !== undefined) return { ok: false, error: 'Give either a battle id or battle "open", not both' };
    return { ok: true, battleId: null };
  }
  const id = wholeNumber(raw.battleId);
  if (id === null || id < 1) return { ok: false, error: "The battle id must be a positive integer" };
  return { ok: true, battleId: id };
}

const wholeNumber = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^[0-9]{1,15}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : null;
};

/** An asset reference as typed. Printable single-line text only; resolution decides whether it is a real asset. */
export const isAssetRef = (v: unknown): v is string =>
  typeof v === "string" && v.trim() === v && v.length >= 1 && v.length <= MAX_ASSET_REF_CHARS && !/[\u0000-\u001f\u007f<>`"\\]/.test(v);

/** Validates untrusted parser output (a model reply or a route body) into an intent. Unknown fields are refused. */
export function validateLifecycleIntent(raw: unknown): LifecycleParseResult {
  if (!isObject(raw)) return fail("The intent must be an object");
  const kind = String(raw.kind);
  const allowed = FIELDS[kind];
  if (!allowed) return fail("The intent kind must be create_battle, join_battle, cancel_battle, claim_refund, register_position, deposit, payout, list_battles or show_positions");
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) return fail(`Unknown field: ${key}`);

  if (kind === "list_battles") {
    if (raw.status !== "open" && raw.status !== "all") return fail('The battle filter must be "open" or "all"');
    return { ok: true, intent: { kind, status: raw.status } };
  }
  if (kind === "show_positions") return { ok: true, intent: { kind } };

  if (kind === "create_battle") {
    if (!SCORING_MODES.includes(raw.mode as ScoringMode)) return fail("The scoring mode must be PriceGain, MarketCapGrowth, VolumeRatio or LowestDrawdown");
    const minutes = wholeNumber(raw.startInMinutes);
    if (minutes === null || minutes < MIN_START_MINUTES || minutes > MAX_START_MINUTES) {
      return fail("The start must be 1 minute to 7 days from now (1 to 10080 minutes)");
    }
    return { ok: true, intent: { kind, mode: raw.mode as ScoringMode, startInMinutes: minutes } };
  }

  if (kind === "join_battle" || kind === "cancel_battle" || kind === "claim_refund" || kind === "register_position" || kind === "deposit") {
    const ref = battleRefOf(raw);
    if (!ref.ok) return fail(ref.error);
    const battleId = ref.battleId;
    if (kind === "cancel_battle" || kind === "claim_refund") {
      // These act on one known battle: "an open arena" makes no sense for a cancel or a refund.
      if (battleId === null) return fail("The battle id must be a positive integer");
    }
    if (kind === "cancel_battle") return { ok: true, intent: { kind, battleId: battleId! } };
    if (kind === "join_battle") {
      if (!isAssetRef(raw.tokenRef)) return fail("The token must be a short single-line token reference");
      return { ok: true, intent: { kind, battleId, tokenRef: raw.tokenRef } };
    }
    // A community is a number, or (deposit only) the token of the community to back.
    const hasNumber = raw.communityNumber !== undefined;
    const hasToken = raw.tokenRef !== undefined;
    if (hasNumber && hasToken) return fail("Give either a community number or a token, not both");
    let community: number | null = null;
    if (hasNumber) {
      const number = wholeNumber(raw.communityNumber);
      if (number === null || number < 1 || number > MAX_COMMUNITY_NUMBER) return fail(`The community must be 1 to ${MAX_COMMUNITY_NUMBER}`);
      community = number - 1;
    }
    if (kind === "claim_refund") {
      if (community === null || hasToken) return fail(`The community must be 1 to ${MAX_COMMUNITY_NUMBER}`);
      return { ok: true, intent: { kind, battleId: battleId!, community } };
    }
    if (kind === "register_position") {
      if (community === null || hasToken) return fail(`The community must be 1 to ${MAX_COMMUNITY_NUMBER}`);
      return { ok: true, intent: { kind, battleId, community } };
    }
    // deposit
    let tokenRef: string | null = null;
    if (hasToken) {
      if (!isAssetRef(raw.tokenRef)) return fail("The token must be a short single-line token reference");
      tokenRef = raw.tokenRef;
    }
    if (community === null && tokenRef === null) return fail(`Say which community (1 to ${MAX_COMMUNITY_NUMBER}) or which token to back`);
    if (raw.amount !== undefined && raw.amountTokens !== undefined) return fail("Give the amount once");
    let amount: string | null = null;
    if (raw.amountTokens !== undefined) {
      amount = typeof raw.amountTokens === "string" || typeof raw.amountTokens === "number" ? tokensToBaseUnits(String(raw.amountTokens)) : null;
      if (amount === null) return fail("The amount must be a positive number of tokens such as 100 or 0.5 (at most 18 decimals, no separators or signs)");
    } else {
      if (typeof raw.amount !== "string" || !AMOUNT.test(raw.amount)) return fail("The amount must be a positive whole number in token base units (digits only)");
      amount = raw.amount;
    }
    return { ok: true, intent: { kind, battleId, community, tokenRef, amount } };
  }

  if (typeof raw.backing !== "string" || !ACCOUNT.test(raw.backing)) return fail("The backing must be a NEAR account id");
  if (typeof raw.amount !== "string" || !AMOUNT.test(raw.amount)) return fail("The amount must be a positive whole number (digits only)");
  if (typeof raw.destination !== "string" || !EVM.test(raw.destination) || /^0x0{40}$/i.test(raw.destination)) return fail("The destination must be a non-zero 20-byte hex address");
  return { ok: true, intent: { kind: "payout", backing: raw.backing, amount: raw.amount, destination: raw.destination.toLowerCase() } };
}

/**
 * The action-service request for an intent. `create_battle` has no request here (a battle is created with the
 * creator's deposit on the create page), and `join_battle` needs the representation resolved from the arena's
 * allowlist; without it there is no request. The
 * returned object is what the preview call posts and what the review is compared against; it never contains free text.
 */
export function intentToRequest(
  intent: LifecycleIntent, resolved: { startAtMs?: string; representation?: string } = {},
): Record<string, unknown> | null {
  switch (intent.kind) {
    case "register_position":
      // "An open arena" has no request until the terminal has resolved it to one battle id.
      return intent.battleId === null ? null : registerRequest(intent.battleId, intent.community);
    case "deposit":
      return intent.battleId === null || intent.community === null ? null : depositRequest(intent.battleId, intent.community, intent.amount);
    case "payout":
      return { kind: "payout", backing: intent.backing, amount: intent.amount, destination: intent.destination };
    case "create_battle":
      // D41: a battle is created with the creator's deposit (token and amount), which this prompt does not
      // carry, so creation is done on the create page and the terminal builds no request for it.
      return null;
    case "join_battle":
      return resolved.representation && intent.battleId !== null ? joinRequest(intent.battleId, resolved.representation) : null;
    case "cancel_battle":
      return cancelRequest(intent.battleId);
    case "claim_refund":
      return refundRequest(intent.battleId, intent.community);
    case "list_battles":
    case "show_positions":
      return null; // read-only: nothing is ever previewed or signed
  }
}

const battleField = (battleId: number | null): Record<string, unknown> => (battleId === null ? { battle: "open" } : { battleId });

/** The wire form of an intent (what the model and the route exchange): the inverse of `validateLifecycleIntent`. */
export function toWireIntent(intent: LifecycleIntent): Record<string, unknown> {
  switch (intent.kind) {
    case "create_battle":
      return { kind: intent.kind, mode: intent.mode, startInMinutes: intent.startInMinutes };
    case "join_battle":
      return { kind: intent.kind, ...battleField(intent.battleId), tokenRef: intent.tokenRef };
    case "cancel_battle":
      return { kind: intent.kind, battleId: intent.battleId };
    case "claim_refund":
      return { kind: intent.kind, battleId: intent.battleId, communityNumber: intent.community + 1 };
    case "register_position":
      return { kind: intent.kind, ...battleField(intent.battleId), communityNumber: intent.community + 1 };
    case "deposit":
      return {
        kind: intent.kind,
        ...battleField(intent.battleId),
        ...(intent.community !== null ? { communityNumber: intent.community + 1 } : { tokenRef: intent.tokenRef }),
        amount: intent.amount,
      };
    case "payout":
      return { ...intent };
    case "list_battles":
      return { kind: intent.kind, status: intent.status };
    case "show_positions":
      return { kind: intent.kind };
  }
}

const battleText = (battleId: number | null): string => (battleId === null ? "an open arena" : `battle #${battleId}`);
const tokensText = (baseUnits: string): string => `${formatUnits(BigInt(baseUnits), TOKEN_DECIMALS, 6)} tokens`;

/** One-line description of the intent for the "what I understood" summary. */
export function describeIntent(intent: LifecycleIntent): string {
  switch (intent.kind) {
    case "create_battle":
      return `Create an open ${intent.mode} battle that starts in ${intent.startInMinutes} minute${intent.startInMinutes === 1 ? "" : "s"}`;
    case "join_battle":
      return `Join ${battleText(intent.battleId)} with ${intent.tokenRef}`;
    case "cancel_battle":
      return `Cancel battle #${intent.battleId}`;
    case "claim_refund":
      return `Claim a refund from battle #${intent.battleId}, community ${intent.community + 1}`;
    case "register_position":
      return `Register a position in ${battleText(intent.battleId)}, community ${intent.community + 1}`;
    case "deposit":
      return `Deposit ${tokensText(intent.amount)} into ${battleText(intent.battleId)}, ${intent.community !== null ? `community ${intent.community + 1}` : `the ${intent.tokenRef} community`}`;
    case "payout":
      return `Request a payout of ${intent.amount} base units to ${intent.destination}`;
    case "list_battles":
      return intent.status === "open" ? "Show the arenas that are open now" : "Show the latest arenas";
    case "show_positions":
      return "Show my positions";
  }
}
