// Lifecycle terminal intents: strict validation of untrusted parser output and the mapping to action requests.
// Field rules mirror `validateRequest` in agent/src/mcp/actions/preview.ts. A parser (rules or model) only PROPOSES
// an intent: it never supplies an address, never authorizes and never reaches the wallet. Token addresses come from
// the backend asset registry after resolution (`lifecycle-resolve.ts`), receivers from the battle read.

import { registerRequest, depositRequest } from "@/lib/arena-read/deposit-flow";
import { toActionRequest, MAX_COMMUNITIES, MIN_COMMUNITIES, SCORING_MODES, type AssetDraft } from "@/lib/arena-read/create-review";
import type { ScoringMode } from "@/lib/arena-read/lifecycle";

/** Sixteen full 0x addresses are about 700 characters, so the limit leaves room for a maximal create prompt. */
export const MAX_PROMPT_CHARS = 1200;
export const MAX_ASSET_REF_CHARS = 80;
/** Users count communities from 1 (as the UI labels them); intents store the contract's 0-based index. */
export const MAX_COMMUNITY_NUMBER = 16;

const AMOUNT = /^[1-9][0-9]{0,38}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;

export type LifecycleIntent =
  /** `assetRefs` are what the user wrote, not addresses. They are resolved through the registry before any review exists. */
  | { kind: "create_battle"; mode: ScoringMode; assetRefs: string[] }
  | { kind: "register_position"; battleId: number; community: number }
  | { kind: "deposit"; battleId: number; community: number; amount: string }
  | { kind: "payout"; backing: string; amount: string; destination: string };

export type LifecycleParseResult =
  | { ok: true; intent: LifecycleIntent }
  | { ok: false; error: string; /** Set when the user should be asked a follow-up question. */ clarify?: boolean };

/** A parser never throws; every failure is a result. */
export interface LifecycleIntentParser {
  readonly name: string;
  parse(prompt: string): Promise<LifecycleParseResult>;
}

/** Wire shape the model and the route use. `communityNumber` is 1-based; everything else is the intent. */
export const LIFECYCLE_INTENT_JSON_SCHEMA = {
  oneOf: [
    { kind: "create_battle", mode: "PriceGain|MarketCapGrowth|VolumeRatio|LowestDrawdown", assetRefs: "2 to 16 strings exactly as the user wrote each token (never invent an address)" },
    { kind: "register_position", battleId: "positive integer", communityNumber: "1 to 16" },
    { kind: "deposit", battleId: "positive integer", communityNumber: "1 to 16", amount: "digits only, positive integer in token base units" },
    { kind: "payout", backing: "NEAR account id", amount: "digits only, positive integer", destination: "0x + 40 hex" },
  ],
} as const;

const fail = (error: string): LifecycleParseResult => ({ ok: false, error });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const FIELDS: Record<string, readonly string[]> = {
  create_battle: ["kind", "mode", "assetRefs"],
  register_position: ["kind", "battleId", "communityNumber"],
  deposit: ["kind", "battleId", "communityNumber", "amount"],
  payout: ["kind", "backing", "amount", "destination"],
};

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
  if (!allowed) return fail("The intent kind must be create_battle, register_position, deposit or payout");
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) return fail(`Unknown field: ${key}`);

  if (kind === "create_battle") {
    if (!SCORING_MODES.includes(raw.mode as ScoringMode)) return fail("The scoring mode must be PriceGain, MarketCapGrowth, VolumeRatio or LowestDrawdown");
    const refs = raw.assetRefs;
    if (!Array.isArray(refs) || refs.length < MIN_COMMUNITIES || refs.length > MAX_COMMUNITIES) return fail(`A battle needs ${MIN_COMMUNITIES} to ${MAX_COMMUNITIES} communities`);
    if (!refs.every(isAssetRef)) return fail("Every community must be a short single-line token reference");
    const keys = new Set(refs.map((r) => (r as string).toLowerCase()));
    if (keys.size !== refs.length) return fail("The same community is listed twice");
    return { ok: true, intent: { kind, mode: raw.mode as ScoringMode, assetRefs: [...(refs as string[])] } };
  }

  if (kind === "register_position" || kind === "deposit") {
    const battleId = wholeNumber(raw.battleId);
    if (battleId === null || battleId < 1) return fail("The battle id must be a positive integer");
    const number = wholeNumber(raw.communityNumber);
    if (number === null || number < 1 || number > MAX_COMMUNITY_NUMBER) return fail(`The community must be 1 to ${MAX_COMMUNITY_NUMBER}`);
    if (kind === "register_position") return { ok: true, intent: { kind, battleId, community: number - 1 } };
    if (typeof raw.amount !== "string" || !AMOUNT.test(raw.amount)) return fail("The amount must be a positive whole number in token base units (digits only)");
    return { ok: true, intent: { kind, battleId, community: number - 1, amount: raw.amount } };
  }

  if (typeof raw.backing !== "string" || !ACCOUNT.test(raw.backing)) return fail("The backing must be a NEAR account id");
  if (typeof raw.amount !== "string" || !AMOUNT.test(raw.amount)) return fail("The amount must be a positive whole number (digits only)");
  if (typeof raw.destination !== "string" || !EVM.test(raw.destination) || /^0x0{40}$/i.test(raw.destination)) return fail("The destination must be a non-zero 20-byte hex address");
  return { ok: true, intent: { kind: "payout", backing: raw.backing, amount: raw.amount, destination: raw.destination.toLowerCase() } };
}

/**
 * The action-service request for an intent. `create_battle` needs assets resolved through the registry (with the
 * representation and custody domain entered by the user); without them there is no request. The returned object is
 * what the preview call posts and what the review is compared against; it never contains free text.
 */
export function intentToRequest(intent: LifecycleIntent, assets?: readonly AssetDraft[]): Record<string, unknown> | null {
  switch (intent.kind) {
    case "register_position":
      return registerRequest(intent.battleId, intent.community);
    case "deposit":
      return depositRequest(intent.battleId, intent.community, intent.amount);
    case "payout":
      return { kind: "payout", backing: intent.backing, amount: intent.amount, destination: intent.destination };
    case "create_battle":
      return assets && assets.length === intent.assetRefs.length ? toActionRequest(assets, intent.mode) : null;
  }
}

/** The wire form of an intent (what the model and the route exchange): the inverse of `validateLifecycleIntent`. */
export function toWireIntent(intent: LifecycleIntent): Record<string, unknown> {
  switch (intent.kind) {
    case "create_battle":
      return { kind: intent.kind, mode: intent.mode, assetRefs: intent.assetRefs };
    case "register_position":
      return { kind: intent.kind, battleId: intent.battleId, communityNumber: intent.community + 1 };
    case "deposit":
      return { kind: intent.kind, battleId: intent.battleId, communityNumber: intent.community + 1, amount: intent.amount };
    case "payout":
      return { ...intent };
  }
}

/** One-line description of the intent for the "what I understood" summary. */
export function describeIntent(intent: LifecycleIntent): string {
  switch (intent.kind) {
    case "create_battle":
      return `Create a ${intent.mode} battle with ${intent.assetRefs.length} communities`;
    case "register_position":
      return `Register a position in battle #${intent.battleId}, community ${intent.community + 1}`;
    case "deposit":
      return `Deposit ${intent.amount} base units into battle #${intent.battleId}, community ${intent.community + 1}`;
    case "payout":
      return `Request a payout of ${intent.amount} base units to ${intent.destination}`;
  }
}
