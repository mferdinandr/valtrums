import type { ScoringMode } from "./lifecycle";
import { localTime, startTimeProblems } from "./open-arena";

/**
 * Review of the calls that create a battle (D41). A battle exists only with its creator's deposit: the creator
 * sends a token on the arena's allowlist to the arena with `ft_transfer_call` and a `lifecycle_create` message,
 * and the arena holds it in escrow until the community is approved. The arguments are exactly the wire shape
 * the agent's action preview builds (`agent/src/mcp/actions/preview.ts`), so the page shows what a wallet would
 * be asked to sign. The creation storage is paid from NEAR the creator prepaid on the arena
 * (`lifecycle_storage_deposit`), a separate, withdrawable step. There is no bond, no USDC and no round duration:
 * a lifecycle round is 30 seconds and set by the contract. Eligibility is NOT decided here: the arena checks the
 * allowlist and the start window, and a cosmetic symbol never makes a token eligible.
 */

/** Communities listed at creation; the two-community minimum applies at the lock. */
export const MIN_COMMUNITIES = 0;
/** Mirrors `MAX_COMMUNITIES` in contracts/arena/src/lifecycle.rs. */
export const MAX_COMMUNITIES = 16;
export const SCORING_MODES: readonly ScoringMode[] = ["PriceGain", "MarketCapGrowth", "VolumeRatio", "LowestDrawdown"];

/**
 * Modes a new battle may use on this deployment. The arena keeps one observation policy and its hash binds one
 * mode, so a battle of another mode could lock and then never start its rounds, keeping its deposits locked.
 * Read from a comma-separated list (NEXT_PUBLIC_LIFECYCLE_CREATE_MODES); unknown names are ignored; the default
 * is PriceGain, the mode of the draft testnet policy.
 */
export function parseCreateModes(raw: string | undefined): ScoringMode[] {
  const picked = (raw ?? "").split(",").map((m) => m.trim()).filter((m): m is ScoringMode => (SCORING_MODES as readonly string[]).includes(m));
  const unique = [...new Set(picked)];
  return unique.length > 0 ? unique : ["PriceGain"];
}
/** Gas of the creation `ft_transfer_call` (the arena receives what the token forwards). */
export const CREATE_GAS_TGAS = "100";
/** Prepaid storage the arena needs before it creates a battle (heads-up bound, mirrors the agent). */
export const CREATE_STORAGE_MIN_YOCTO = "10000000000000000000000";
/** What one prepayment adds (0.05 NEAR, roughly ten battles); the unused part is withdrawable. */
export const PREPAY_STORAGE_YOCTO = "50000000000000000000000";
export const PREPAY_GAS_TGAS = "30";

/** The token and amount a creator deposits to create a battle. */
export interface CreatorDeposit {
  /** NEAR representation account of an allowlisted token. */
  representation: string;
  /** Base units, a positive decimal string. */
  amount: string;
  /** Display name only; never part of the request. */
  label?: string;
}

/** What a wallet will be asked to sign, in the shape the preview comparison needs (create, register and deposit). */
export interface CallReview {
  receiver: string;
  method: string;
  args: unknown;
  depositYocto: string;
  gasTgas: string;
  lines: Array<{ label: string; value: string }>;
  notes: string[];
}

export type ReviewResult = ({ ok: true } & CallReview) | { ok: false; problems: string[] };

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const validAccount = (s: string): boolean => s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);
const AMOUNT = /^[1-9][0-9]{0,38}$/;

/** The `lifecycle_create` message. Key order matters: the agent builds the same string and the two are compared. */
export const createMessage = (mode: string, startAtMs: string): string =>
  JSON.stringify({ action: "lifecycle_create", mode, start_at_ms: startAtMs });

export function buildCreatorDepositReview(
  arenaContract: string, deposit: CreatorDeposit, mode: string, startAtMs: string | null, nowMs: number,
  allowedModes: readonly ScoringMode[] = SCORING_MODES,
): ReviewResult {
  const problems: string[] = [];
  if (!(SCORING_MODES as readonly string[]).includes(mode)) problems.push("choose a challenge");
  else if (!(allowedModes as readonly string[]).includes(mode)) {
    problems.push("this challenge is not live on this arena yet, so a battle with it could never start. Pick a live challenge");
  }
  problems.push(...startTimeProblems(startAtMs, nowMs));
  if (!validAccount(deposit.representation)) problems.push("choose the token you deposit first");
  if (!AMOUNT.test(deposit.amount)) problems.push("enter the amount you deposit");
  if (!validAccount(arenaContract)) problems.push("the arena contract id is not configured");
  if (problems.length > 0) return { ok: false, problems };
  const msg = createMessage(mode, startAtMs as string);
  const name = deposit.label ?? deposit.representation;
  return {
    ok: true,
    receiver: deposit.representation,
    method: "ft_transfer_call",
    args: { receiver_id: arenaContract, amount: deposit.amount, msg },
    depositYocto: "1",
    gasTgas: CREATE_GAS_TGAS,
    lines: [
      { label: "Token contract", value: deposit.representation },
      { label: "Method", value: "ft_transfer_call" },
      { label: "Recipient", value: arenaContract },
      { label: "Amount", value: `${deposit.amount} base units of ${name}` },
      { label: "Challenge", value: mode },
      { label: "Start time", value: `${localTime(Number(startAtMs))} (${startAtMs} ms)` },
      { label: "Attached deposit", value: "1 yoctoNEAR (required by ft_transfer_call)" },
      { label: "Gas", value: `${CREATE_GAS_TGAS} Tgas` },
    ],
    notes: [
      "Your tokens are held in escrow by the arena until the audit and backing approvals of your token exist, then they become your position.",
      "If the arena refuses the creation (for example a token it does not accept), your tokens are returned.",
      "The creation storage is paid from NEAR you prepaid on the arena. It is not a bond.",
    ],
  };
}

/** One-time (or top-up) prepayment of the NEAR that pays the storage of battles the account creates. */
export function buildPrepayReview(arenaContract: string, amountYocto: string = PREPAY_STORAGE_YOCTO): ReviewResult {
  const problems: string[] = [];
  if (!validAccount(arenaContract)) problems.push("the arena contract id is not configured");
  if (!AMOUNT.test(amountYocto)) problems.push("the prepayment must be a positive amount");
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    receiver: arenaContract,
    method: "lifecycle_storage_deposit",
    args: {},
    depositYocto: amountYocto,
    gasTgas: PREPAY_GAS_TGAS,
    lines: [
      { label: "Contract", value: arenaContract },
      { label: "Method", value: "lifecycle_storage_deposit" },
      { label: "Prepaid NEAR", value: `${amountYocto} yoctoNEAR` },
      { label: "Gas", value: `${PREPAY_GAS_TGAS} Tgas` },
    ],
    notes: ["This NEAR pays the storage of battles you create. It is not a bond and you can withdraw the unused part."],
  };
}

/** The request body the action service expects for `create_battle` (the same shape as the agent's request). */
export const creatorDepositRequest = (deposit: CreatorDeposit, mode: string, startAtMs: string | null): Record<string, unknown> => ({
  kind: "create_battle", representation: deposit.representation, amount: deposit.amount, mode, ...(startAtMs ? { startAtMs } : {}),
});

export const prepayRequest = (amountYocto: string = PREPAY_STORAGE_YOCTO): Record<string, unknown> => ({ kind: "prepay_storage", amountYocto });

/** The part of the server's canonical preview that must equal what the user reviewed. */
export interface PreviewLike {
  accountId?: unknown;
  transaction?: { signerId?: unknown; receiverId?: unknown; actions?: Array<{ methodName?: unknown; args?: unknown; deposit?: unknown }> };
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/**
 * Differences between the canonical preview the service built and the transaction the user reviewed.
 * An empty list means the service will ask the wallet to sign exactly the reviewed call; anything else
 * must stop the flow before any authorization is requested.
 */
export function previewMismatches(preview: PreviewLike, review: CallReview, account: string): string[] {
  const out: string[] = [];
  const tx = preview.transaction;
  if (!tx) return ["the preview has no transaction"];
  if (tx.signerId !== account || preview.accountId !== account) out.push("the preview is for another account");
  if (tx.receiverId !== review.receiver) out.push("the preview targets another contract");
  const actions = tx.actions ?? [];
  if (actions.length !== 1) return [...out, "the preview does not contain exactly one call"];
  const call = actions[0]!;
  if (call.methodName !== review.method) out.push("the preview calls another method");
  if (canonical(call.args) !== canonical(review.args)) out.push("the preview arguments differ from the reviewed arguments");
  if (call.deposit !== review.depositYocto) out.push("the preview attaches another deposit");
  return out;
}
