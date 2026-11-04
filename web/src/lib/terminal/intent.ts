// Intent types, strict validation of untrusted parser output, and the parser interface.
// Amounts are decimal USDC strings ("50", "12.5"); conversion to base units happens in one place (`usdcUnits`).

import { USDC_DECIMALS, parseUnits } from "../amounts";

export type SourceKind = "credit" | "near_wallet" | "other_chain";

export interface IntentSource {
  kind: SourceKind;
  /** Decimal USDC amount. */
  amount: string;
  /** Lowercase chain name; present only for `other_chain`. */
  chain?: string;
}

export interface ParsedIntent {
  action: "deposit";
  /** Battle id, when the prompt names one. */
  battle?: number;
  /** Token symbol (uppercase, no `$`) or a NEP-141 contract id. */
  token?: string;
  side?: "A" | "B";
  /** Decimal USDC amount. Always equals the sum of `sources`. */
  totalUsdc: string;
  sources: IntentSource[];
  slippageBps: number;
}

export type ParseResult =
  | { ok: true; intent: ParsedIntent }
  | { ok: false; error: string; /** Set when the user should be asked a follow-up question. */ clarify?: boolean };

/** A parser never throws; every failure is a `ParseResult`. */
export interface IntentParser {
  readonly name: string;
  parse(prompt: string): Promise<ParseResult>;
}

export const MAX_PROMPT_CHARS = 500;
export const DEFAULT_SLIPPAGE_BPS = 100;
export const MAX_SLIPPAGE_BPS = 1000;
/** Sanity cap on a single intent: 1,000,000 USDC. */
export const MAX_TOTAL_UNITS = 1_000_000n * 10n ** BigInt(USDC_DECIMALS);

export const SUPPORTED_CHAINS = [
  "base",
  "ethereum",
  "arbitrum",
  "optimism",
  "polygon",
  "bsc",
  "avalanche",
  "solana",
  "ton",
  "tron",
] as const;

const CHAIN_ALIASES: Record<string, string> = { eth: "ethereum", arb: "arbitrum", op: "optimism", bnb: "bsc", sol: "solana" };

export function normalizeChain(raw: string): string | null {
  const c = raw.trim().toLowerCase();
  const mapped = CHAIN_ALIASES[c] ?? c;
  return (SUPPORTED_CHAINS as readonly string[]).includes(mapped) ? mapped : null;
}

export function usdcUnits(amount: string): bigint | null {
  return parseUnits(amount, USDC_DECIMALS);
}

export function formatDecimal(units: bigint): string {
  const base = 10n ** BigInt(USDC_DECIMALS);
  const frac = (units % base).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${units / base}${frac ? `.${frac}` : ""}`;
}

const TOP_KEYS = new Set(["action", "battle", "token", "side", "totalUsdc", "sources", "slippageBps"]);
const SOURCE_KEYS = new Set(["kind", "amount", "chain"]);
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Accepts a positive decimal given as a string or finite number; returns the canonical decimal string. */
function readAmount(v: unknown): string | null {
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    s = String(v);
  } else if (typeof v === "string") {
    s = v.trim();
  } else return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const units = usdcUnits(s);
  if (units === null || units <= 0n || units > MAX_TOTAL_UNITS) return null;
  return formatDecimal(units);
}

const fail = (error: string): ParseResult => ({ ok: false, error });

/**
 * Validate an untrusted value (model output, request body) into a ParsedIntent.
 * Unknown keys, wrong types, out-of-range values and inconsistent sums are all rejected.
 */
export function validateIntent(raw: unknown): ParseResult {
  if (!isRecord(raw)) return fail("Intent must be a JSON object");
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) return fail(`Unexpected field "${k}"`);
  if (raw.action !== "deposit") return fail('Only the "deposit" action is supported');

  const intent: ParsedIntent = { action: "deposit", totalUsdc: "", sources: [], slippageBps: DEFAULT_SLIPPAGE_BPS };

  if (raw.battle !== undefined && raw.battle !== null) {
    if (typeof raw.battle !== "number" || !Number.isInteger(raw.battle) || raw.battle < 1 || raw.battle > 1_000_000_000)
      return fail("battle must be a positive integer");
    intent.battle = raw.battle;
  }
  if (raw.token !== undefined && raw.token !== null) {
    if (typeof raw.token !== "string") return fail("token must be a string");
    const t = raw.token.trim().replace(/^\$/, "");
    if (!TOKEN_RE.test(t)) return fail("token is not a valid symbol or contract id");
    intent.token = t;
  }
  if (raw.side !== undefined && raw.side !== null) {
    if (raw.side !== "A" && raw.side !== "B") return fail('side must be "A" or "B"');
    intent.side = raw.side;
  }

  if (!Array.isArray(raw.sources) || raw.sources.length < 1 || raw.sources.length > 4)
    return fail("sources must list between 1 and 4 entries");
  const seen = new Set<string>();
  let sum = 0n;
  for (const s of raw.sources) {
    if (!isRecord(s)) return fail("each source must be an object");
    for (const k of Object.keys(s)) if (!SOURCE_KEYS.has(k)) return fail(`Unexpected source field "${k}"`);
    if (s.kind !== "credit" && s.kind !== "near_wallet" && s.kind !== "other_chain") return fail("unknown source kind");
    const amount = readAmount(s.amount);
    if (amount === null) return fail("source amount must be a positive USDC amount with at most 6 decimals");
    let chain: string | undefined;
    if (s.kind === "other_chain") {
      if (typeof s.chain !== "string") return fail("other_chain sources need a chain");
      const c = normalizeChain(s.chain);
      if (c === null) return fail(`unsupported chain "${String(s.chain).slice(0, 24)}"`);
      chain = c;
    } else if (s.chain !== undefined && s.chain !== null) {
      return fail("chain is only allowed on other_chain sources");
    }
    const key = `${s.kind}:${chain ?? ""}`;
    if (seen.has(key)) return fail("duplicate funding source");
    seen.add(key);
    sum += usdcUnits(amount)!;
    intent.sources.push(chain ? { kind: s.kind, amount, chain } : { kind: s.kind, amount });
  }

  const total = readAmount(raw.totalUsdc);
  if (total === null) return fail("totalUsdc must be a positive USDC amount with at most 6 decimals");
  if (usdcUnits(total)! !== sum) return fail("totalUsdc does not equal the sum of the sources");
  intent.totalUsdc = total;

  if (raw.slippageBps !== undefined && raw.slippageBps !== null) {
    if (typeof raw.slippageBps !== "number" || !Number.isInteger(raw.slippageBps) || raw.slippageBps < 0 || raw.slippageBps > MAX_SLIPPAGE_BPS)
      return fail(`slippageBps must be an integer between 0 and ${MAX_SLIPPAGE_BPS}`);
    intent.slippageBps = raw.slippageBps;
  }
  if (intent.battle === undefined && intent.token === undefined && intent.side === undefined)
    return { ok: false, error: "Which battle or token should this go to?", clarify: true };
  return { ok: true, intent };
}

/** JSON schema handed to the model (documentation for the model; `validateIntent` is the real gate). */
export const INTENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "totalUsdc", "sources"],
  properties: {
    action: { const: "deposit" },
    battle: { type: "integer", minimum: 1 },
    token: { type: "string", description: "Token symbol without $, e.g. WIF" },
    side: { enum: ["A", "B"] },
    totalUsdc: { type: "string", description: "Decimal USDC, equals the sum of sources" },
    sources: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "amount"],
        properties: {
          kind: { enum: ["credit", "near_wallet", "other_chain"] },
          amount: { type: "string" },
          chain: { enum: [...SUPPORTED_CHAINS], description: "Only for other_chain" },
        },
      },
    },
    slippageBps: { type: "integer", minimum: 0, maximum: MAX_SLIPPAGE_BPS },
  },
} as const;
