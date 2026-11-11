import type { ScoringMode } from "./lifecycle";
import { startTimeProblems, utc } from "./open-arena";

/**
 * Review of a `create_lifecycle_battle` call (issue #149). The arguments are exactly the wire shape the
 * agent's action preview builds (`agent/src/mcp/actions/preview.ts`), so the page shows what a wallet
 * would be asked to sign. There is no legacy bond, no USDC and no round duration: a lifecycle round is
 * 30 seconds and set by the contract. Eligibility is NOT decided here: the arena validates the assets
 * and the reference registry at creation, and a cosmetic symbol or model never makes a token eligible.
 *
 * Open arena (D34): the creator sets a start time and normally lists no community; communities join
 * before the start. A start time is required here so that every battle made from the UI can be
 * cancelled and refunded when fewer than two communities are funded.
 */

/** Communities listed at creation; the two-community minimum applies at the lock. */
export const MIN_COMMUNITIES = 0;
/** Mirrors `MAX_COMMUNITIES` in contracts/arena/src/lifecycle.rs. */
export const MAX_COMMUNITIES = 16;
export const SCORING_MODES: readonly ScoringMode[] = ["PriceGain", "MarketCapGrowth", "VolumeRatio", "LowestDrawdown"];
/** Upper bound of the storage deposit the agent previews; the arena keeps actual storage and refunds the rest. */
export const CREATE_DEPOSIT_YOCTO = "100000000000000000000000";
export const CREATE_GAS_TGAS = "100";

export interface AssetDraft {
  chainId: string;
  tokenAddress: string;
  representation: string;
  custodyDomain: string;
  /** Both set, or both empty. Taken from the protocol's reference registry, never typed free-form. */
  referenceChainId: string;
  referenceAddress: string;
  /** Display name from the registry label; never part of the request. */
  label?: string;
}

export interface CreateArgs {
  assets: Array<{
    chain_id: string;
    token_address: string;
    representation: string;
    custody_domain: string;
    reference_chain_id: string | null;
    reference_address: string | null;
  }>;
  mode: ScoringMode;
  start_at_ms: string;
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

export type ReviewResult =
  | { ok: true; args: CreateArgs; method: "create_lifecycle_battle"; receiver: string; depositYocto: string; gasTgas: string; lines: Array<{ label: string; value: string }>; notes: string[] }
  | { ok: false; problems: string[] };

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const validAccount = (s: string): boolean => s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);
const U64 = /^(0|[1-9][0-9]*)$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;

export function buildCreateReview(
  arenaContract: string, assets: readonly AssetDraft[], mode: string, startAtMs: string | null, nowMs: number,
): ReviewResult {
  const problems: string[] = [];
  if (!(SCORING_MODES as readonly string[]).includes(mode)) problems.push("choose a scoring mode");
  problems.push(...startTimeProblems(startAtMs, nowMs));
  if (assets.length > MAX_COMMUNITIES) problems.push(`a battle has at most ${MAX_COMMUNITIES} communities`);
  const seen = new Set<string>();
  const seenReps = new Set<string>();
  assets.forEach((a, i) => {
    const n = i + 1;
    if (!U64.test(a.chainId) || BigInt(a.chainId) >= 2n ** 64n) problems.push(`community ${n}: chain id must be a decimal integer`);
    if (!EVM.test(a.tokenAddress)) problems.push(`community ${n}: token address must be a 20-byte hex address`);
    if (!validAccount(a.representation)) problems.push(`community ${n}: representation must be a valid NEAR account id`);
    if (!a.custodyDomain.trim() || a.custodyDomain.length > 64) problems.push(`community ${n}: custody domain is required (at most 64 characters)`);
    const hasRefChain = a.referenceChainId.trim() !== "";
    const hasRefAddr = a.referenceAddress.trim() !== "";
    if (hasRefChain !== hasRefAddr) problems.push(`community ${n}: a reference needs both its chain id and its address`);
    if (hasRefChain && (!U64.test(a.referenceChainId) || BigInt(a.referenceChainId) >= 2n ** 64n)) problems.push(`community ${n}: reference chain id must be a decimal integer`);
    if (hasRefAddr && !EVM.test(a.referenceAddress)) problems.push(`community ${n}: reference address must be a 20-byte hex address`);
    const key = `${a.chainId}:${a.tokenAddress.toLowerCase()}`;
    if (seen.has(key)) problems.push(`community ${n}: the same asset is listed twice`);
    seen.add(key);
    if (seenReps.has(a.representation)) problems.push(`community ${n}: the same representation is listed twice`);
    seenReps.add(a.representation);
  });
  if (!validAccount(arenaContract)) problems.push("the arena contract id is not configured");
  if (problems.length > 0) return { ok: false, problems };
  const args: CreateArgs = {
    assets: assets.map((a) => ({
      chain_id: a.chainId, token_address: a.tokenAddress, representation: a.representation, custody_domain: a.custodyDomain,
      reference_chain_id: a.referenceChainId.trim() ? a.referenceChainId : null, reference_address: a.referenceAddress.trim() ? a.referenceAddress : null,
    })),
    mode: mode as ScoringMode,
    start_at_ms: startAtMs as string,
  };
  return {
    ok: true, args, method: "create_lifecycle_battle", receiver: arenaContract, depositYocto: CREATE_DEPOSIT_YOCTO, gasTgas: CREATE_GAS_TGAS,
    lines: [
      { label: "Contract", value: arenaContract },
      { label: "Method", value: "create_lifecycle_battle" },
      { label: "Mode", value: mode },
      { label: "Start time", value: `${utc(Number(startAtMs))} (${startAtMs} ms)` },
      { label: "Communities at creation", value: assets.length === 0 ? "none: communities join before the start" : String(assets.length) },
      ...args.assets.map((a, i) => ({ label: `Community ${i + 1}`, value: `${a.chain_id}:${a.token_address} · ${a.representation} · custody ${a.custody_domain}${a.reference_chain_id ? ` · reference ${a.reference_chain_id}:${a.reference_address}` : " · no reference"}` })),
      { label: "Storage deposit (upper bound)", value: `${CREATE_DEPOSIT_YOCTO} yoctoNEAR` },
      { label: "Gas", value: `${CREATE_GAS_TGAS} Tgas` },
    ],
    notes: [
      "The deposit is storage payment, not a stake: the arena keeps the actual storage cost and refunds the rest.",
      "There is no bond and no round duration: rounds are 30 seconds and set by the contract.",
      "You must deposit in one community before the start; the battle needs at least two funded communities at the start or anyone can cancel it and every depositor can claim a refund.",
      "The arena validates assets and the protocol's registry when the transaction runs; this review does not prove eligibility.",
    ],
  };
}

/** The request body the action service expects for `create_battle` (same shape as the agent's `AssetRequest`). */
export function toActionRequest(assets: readonly AssetDraft[], mode: string, startAtMs: string | null): Record<string, unknown> {
  return {
    kind: "create_battle",
    assets: assets.map((a) => ({
      chainId: a.chainId, tokenAddress: a.tokenAddress, representation: a.representation, custodyDomain: a.custodyDomain,
      ...(a.referenceChainId.trim() ? { referenceChainId: a.referenceChainId } : {}),
      ...(a.referenceAddress.trim() ? { referenceAddress: a.referenceAddress } : {}),
    })),
    mode,
    ...(startAtMs ? { startAtMs } : {}),
  };
}

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
