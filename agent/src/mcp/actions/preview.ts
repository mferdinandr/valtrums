import type { DataOrigin } from "../envelope.js";
import type { ScoringMode } from "../read-source.js";
import { FIXTURE_LABEL, FIXTURE_ROUTE } from "../../intents-fixture/label.js";
import { hashCanonical } from "./canonical.js";
import { buildLifecyclePreview } from "./lifecycle-actions.js";
import type { ActionReadSource } from "./source.js";

/**
 * Canonical action previews for the MCP and terminal action boundary (#76).
 *
 * A preview binds everything a user approves: kind, network, the account whose funds move, the
 * signer, assets, amounts, recipient, costs, the preview policy version and the expiry, plus the
 * exact unsigned transaction. `previewHash` covers all of it and is what the user authorizes.
 * `bindingHash` covers the same without timestamps; revalidation rebuilds the preview from fresh
 * chain reads and refuses when it differs, so a changed recipient, amount, policy or state is never
 * signed on an old approval. Model output is never an input to authorization: it may only propose
 * a request, which is then validated here like any other.
 */

export const ACTION_POLICY_VERSION = "action-preview-v1";
/** A preview must be authorized and prepared within this time (owner decision for #76). */
export const PREVIEW_TTL_MS = 5 * 60 * 1000;

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = "1";
/**
 * A battle is created by a creator deposit (D41): one `ft_transfer_call` of the creator's token with a
 * `lifecycle_create` message. The creation storage comes from NEAR the creator prepaid on the arena
 * (`lifecycle_storage_deposit`), so the preview checks the prepaid balance against this heads-up bound; the
 * arena measures the real cost and refuses the creation (returning the tokens) when the balance is short.
 */
export const CREATE_STORAGE_MIN_YOCTO = "10000000000000000000000";
/** Largest prepayment one `prepay_storage` action may carry (10 NEAR), so a typo cannot lock a large amount. */
export const PREPAY_STORAGE_MAX_YOCTO = "10000000000000000000000000";
/** `request_payout` storage deposit (payout `REQUEST_DEPOSIT`, 30 mNEAR); unused part refunded. */
export const PAYOUT_REQUEST_DEPOSIT_YOCTO = "30000000000000000000000";
/** `reserve` storage deposit for a grant reservation; unused part refunded. */
const RESERVE_DEPOSIT_YOCTO = "10000000000000000000000";
/** `join_lifecycle_battle` storage deposit upper bound (0.02 NEAR: a community plus a position); the arena charges measured storage and refunds the rest. */
export const JOIN_DEPOSIT_YOCTO = "20000000000000000000000";
/** `vote_lifecycle_disposition` storage deposit upper bound (0.01 NEAR); the arena refunds the rest. */
export const VOTE_DEPOSIT_YOCTO = "10000000000000000000000";
/** `reserve_lifecycle_escrow` deposit (arena ESCROW_DEPOSIT, 10 mNEAR); the arena refunds the excess. */
export const ESCROW_DEPOSIT_YOCTO = "10000000000000000000000";
/** Per entitlement or release forwarded to a backing (arena ENTITLEMENT_DEPOSIT, 10 mNEAR). */
export const ENTITLEMENT_DEPOSIT = 10_000_000_000_000_000_000_000n;
/** Contract batch bounds: `settle_lifecycle_battle` 15, `execute_lifecycle_disposition` 10. */
export const MAX_SETTLE_BATCH = 15;
export const MAX_EXECUTE_BATCH = 10;
/** Contract bounds of a start time: now + 60 s to now + 7 days. */
export const MIN_START_LEAD_MS = 60_000;
export const MAX_START_LEAD_MS = 7 * 24 * 60 * 60 * 1000;
/** Maximum communities in a battle. */
const MAX_COMMUNITIES = 16;
/** `register_lifecycle_position` storage deposit upper bound (0.01 NEAR); the arena charges actual storage and refunds the rest. */
const REGISTER_DEPOSIT_YOCTO = "10000000000000000000000";

export type ActionKind =
  | "create_battle"
  | "prepay_storage"
  | "register_position"
  | "deposit"
  | "payout"
  | "join_battle"
  | "cancel_battle"
  | "claim_refund"
  | "claim_escrow_refund"
  | "settle_battle"
  | "reserve_escrow"
  | "vote_disposition"
  | "execute_disposition"
  | "request_dao_burn"
  | "claim_entitlement"
  | "register_representation"
  | "late_refund";
export const SUPPORTED_FUNDING_ROUTES = ["direct"] as const;

/**
 * Funding routes the boundary accepts for this configuration. `intents-fixture` (D29) is the local
 * 1Click fixture and is accepted only when the context enables it (testnet configuration only,
 * enforced by `ActionService`). The real `intents` route is not supported and stays refused.
 */
export const fundingRoutes = (ctx: Pick<PreviewContext, "intentsFixture">): readonly string[] =>
  ctx.intentsFixture ? [...SUPPORTED_FUNDING_ROUTES, FIXTURE_ROUTE] : SUPPORTED_FUNDING_ROUTES;

export interface AssetRequest {
  chainId: string;
  tokenAddress: string;
  representation: string;
  custodyDomain: string;
  referenceChainId?: string;
  referenceAddress?: string;
}

/** Acting through an on-chain player-policy grant instead of the user's own signature. */
export interface GrantRequest {
  /** The user whose grant (and funds) this is; the caller must be the grant's delegate. */
  user: string;
  /** 32-byte grant local id, hex. */
  localId: string;
  /** Asset identity mapping version recorded in the grant. */
  mappingVersion: string;
}

export type ActionRequest =
  | {
      kind: "create_battle";
      /** NEAR representation of an allowlisted token the creator deposits; it becomes the first community. */
      representation: string;
      /** Base units of the representation, a positive decimal string. */
      amount: string;
      mode: ScoringMode;
      /** Start time in ms (decimal string). Required: a battle without one could never be cancelled or refunded. */
      startAtMs: string;
    }
  | { kind: "prepay_storage"; /** yoctoNEAR the creator prepays on the arena for battle storage. */ amountYocto: string }
  | { kind: "join_battle"; battleId: number; /** NEAR representation of an allowlisted token; never a community index. */ representation: string }
  | { kind: "cancel_battle"; battleId: number }
  | { kind: "claim_refund"; battleId: number; community: number }
  /** D41: the creator takes the deposit held in escrow back after a cancel. */
  | { kind: "claim_escrow_refund"; battleId: number }
  | { kind: "settle_battle"; battleId: number }
  | { kind: "reserve_escrow"; battleId: number }
  | { kind: "vote_disposition"; battleId: number; burnPercent: number }
  | { kind: "execute_disposition"; battleId: number }
  | { kind: "request_dao_burn"; battleId: number }
  /** Take an entitlement (reward or DAO return) as representation tokens in the caller's NEAR account, 1:1. */
  | { kind: "claim_entitlement"; backing: string; amount: string }
  /** NEP-145 registration of the caller on a backing token, needed before the first claim. */
  | { kind: "register_representation"; backing: string }
  | {
      kind: "late_refund";
      backing: string;
      amount: string;
      /** EVM address on the source chain bound to the caller's own late deposit, 0x + 40 hex. */
      destination: string;
      /** 32-byte request id, hex; assigned at preview when absent and then fixed. */
      requestId?: string;
    }
  | { kind: "register_position"; battleId: number; community: number }
  | {
      kind: "deposit";
      battleId: number;
      community: number;
      amount: string;
      route?: string;
      grant?: GrantRequest;
      /** Grant reservations only: 32-byte request id, hex; assigned at preview when absent. */
      requestId?: string;
    }
  | {
      kind: "payout";
      backing: string;
      amount: string;
      /** EVM address on the source chain, 0x + 40 hex. */
      destination: string;
      /** 32-byte request id, hex; assigned at preview when absent and then fixed. */
      requestId?: string;
      grant?: GrantRequest;
    };

export interface FunctionCall {
  type: "FunctionCall";
  methodName: string;
  args: Record<string, unknown>;
  /** Gas units as a decimal string. */
  gas: string;
  /** Attached deposit in yoctoNEAR as a decimal string. */
  deposit: string;
}

export interface UnsignedTransaction {
  signerId: string;
  receiverId: string;
  actions: FunctionCall[];
}

export interface Preview {
  version: typeof ACTION_POLICY_VERSION;
  kind: ActionKind;
  network: string;
  /** The account whose funds or position the action uses. */
  accountId: string;
  /** Who signs the prepared transaction: the user, or the grant delegate for a reservation. */
  signerId: string;
  authorization: "user_signature" | "grant";
  createdAtMs: number;
  expiresAtMs: number;
  binding: Record<string, unknown>;
  costs: { attachedDepositYocto: string; gasTgas: string; notes: string[] };
  transaction: UnsignedTransaction;
  source: DataOrigin;
  limitations: string[];
}

export type ActionErrorCode =
  | "invalid_request"
  | "unsupported_route"
  | "battle_not_found"
  | "battle_locked"
  | "audit_missing"
  | "storage_balance_low"
  | "not_registered"
  | "not_creator"
  | "audit_expired"
  | "backing_missing"
  | "battle_cancelled"
  | "battle_started"
  | "battle_not_started"
  | "battle_full"
  | "not_joinable"
  | "not_cancellable"
  | "not_cancelled"
  | "nothing_to_refund"
  | "winner_not_resolved"
  | "already_settled"
  | "already_done"
  | "vote_not_open"
  | "vote_closed"
  | "not_a_winner"
  | "escrow_not_reserved"
  | "nothing_to_execute"
  | "release_not_recorded"
  | "sink_not_set"
  | "not_registered"
  | "already_registered"
  | "insufficient_balance"
  | "insufficient_entitlement"
  | "grant_invalid"
  | "not_configured";

export class ActionError extends Error {
  constructor(
    readonly code: ActionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

export interface PreviewContext {
  network: string;
  arena: string;
  payout: string | null;
  policy: string | null;
  /** Accept the `intents-fixture` funding route. Only valid when `network` is `near-testnet`. */
  intentsFixture?: boolean;
}

const ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const AMOUNT = /^[1-9][0-9]{0,38}$/;
const MODES: readonly ScoringMode[] = ["PriceGain", "MarketCapGrowth", "VolumeRatio", "LowestDrawdown"];

export const fail = (code: ActionErrorCode, message: string): never => {
  throw new ActionError(code, message);
};
const account = (value: unknown, what: string): string =>
  typeof value === "string" && ACCOUNT.test(value) ? value : fail("invalid_request", `${what} must be a NEAR account id`);
const amount = (value: unknown): string =>
  typeof value === "string" && AMOUNT.test(value) ? value : fail("invalid_request", "amount must be a positive integer string");
export const hexBytes = (hex: string): number[] => Array.from(Buffer.from(hex, "hex"));
export const gas = (tgas: bigint): string => (tgas * TGAS).toString();

function validateGrant(grant: unknown): GrantRequest {
  const g = grant as Partial<GrantRequest> | null;
  if (!g || typeof g !== "object") return fail("invalid_request", "grant must be an object");
  if (typeof g.localId !== "string" || !HEX32.test(g.localId)) fail("invalid_request", "grant.localId must be 32 bytes of lowercase hex");
  if (typeof g.mappingVersion !== "string" || !/^[0-9]{1,19}$/.test(g.mappingVersion)) {
    fail("invalid_request", "grant.mappingVersion must be a decimal string");
  }
  return { user: account(g.user, "grant.user"), localId: g.localId as string, mappingVersion: g.mappingVersion as string };
}

/** Validates a request's shape. Unknown kinds and unsupported funding routes are refused here. */
export function validateRequest(raw: unknown, routes: readonly string[] = SUPPORTED_FUNDING_ROUTES): ActionRequest {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) return fail("invalid_request", "request must be an object");
  const allowed: Record<string, string[]> = {
    create_battle: ["kind", "representation", "amount", "mode", "startAtMs"],
    prepay_storage: ["kind", "amountYocto"],
    register_position: ["kind", "battleId", "community"],
    deposit: ["kind", "battleId", "community", "amount", "route", "grant", "requestId"],
    payout: ["kind", "backing", "amount", "destination", "requestId", "grant"],
    join_battle: ["kind", "battleId", "representation"],
    cancel_battle: ["kind", "battleId"],
    claim_refund: ["kind", "battleId", "community"],
    claim_escrow_refund: ["kind", "battleId"],
    settle_battle: ["kind", "battleId"],
    reserve_escrow: ["kind", "battleId"],
    vote_disposition: ["kind", "battleId", "burnPercent"],
    execute_disposition: ["kind", "battleId"],
    request_dao_burn: ["kind", "battleId"],
    claim_entitlement: ["kind", "backing", "amount"],
    register_representation: ["kind", "backing"],
    late_refund: ["kind", "backing", "amount", "destination", "requestId"],
  };
  const keys = Object.hasOwn(allowed, String(r.kind)) ? allowed[String(r.kind)] : undefined;
  if (!keys) return fail("invalid_request", `kind must be one of ${Object.keys(allowed).join(", ")}`);
  for (const k of Object.keys(r)) if (!keys.includes(k)) fail("invalid_request", `unknown field: ${k}`);
  const battleIdOf = (): number => {
    const battleId = Number(r.battleId);
    if (!Number.isSafeInteger(battleId) || battleId < 1) fail("invalid_request", "battleId must be a positive integer");
    return battleId;
  };
  if (r.kind === "join_battle") return { kind: "join_battle", battleId: battleIdOf(), representation: account(r.representation, "representation") };
  if (r.kind === "cancel_battle" || r.kind === "claim_escrow_refund" || r.kind === "settle_battle" || r.kind === "reserve_escrow" || r.kind === "execute_disposition" || r.kind === "request_dao_burn") {
    return { kind: r.kind, battleId: battleIdOf() };
  }
  if (r.kind === "claim_refund") {
    const community = Number(r.community);
    if (!Number.isSafeInteger(community) || community < 0 || community > MAX_COMMUNITIES - 1) fail("invalid_request", "community must be 0 to 15");
    return { kind: "claim_refund", battleId: battleIdOf(), community };
  }
  if (r.kind === "vote_disposition") {
    if (typeof r.burnPercent !== "number" || !Number.isInteger(r.burnPercent) || r.burnPercent < 0 || r.burnPercent > 100) return fail("invalid_request", "burnPercent must be an integer from 0 to 100");
    return { kind: "vote_disposition", battleId: battleIdOf(), burnPercent: r.burnPercent };
  }
  if (r.kind === "claim_entitlement") return { kind: "claim_entitlement", backing: account(r.backing, "backing"), amount: amount(r.amount) };
  if (r.kind === "register_representation") return { kind: "register_representation", backing: account(r.backing, "backing") };
  if (r.kind === "late_refund") {
    if (typeof r.destination !== "string" || !EVM.test(r.destination) || /^0x0{40}$/i.test(r.destination)) {
      fail("invalid_request", "destination must be a non-zero 20-byte hex address");
    }
    if (r.requestId !== undefined && (typeof r.requestId !== "string" || !HEX32.test(r.requestId) || /^0{64}$/.test(r.requestId))) {
      fail("invalid_request", "requestId must be 32 non-zero bytes of lowercase hex");
    }
    return {
      kind: "late_refund",
      backing: account(r.backing, "backing"),
      amount: amount(r.amount),
      destination: (r.destination as string).toLowerCase(),
      ...(r.requestId !== undefined ? { requestId: r.requestId as string } : {}),
    };
  }
  if (r.kind === "create_battle") {
    const raw = typeof r.startAtMs === "number" && Number.isSafeInteger(r.startAtMs) ? String(r.startAtMs) : r.startAtMs;
    if (typeof raw !== "string" || !/^[1-9][0-9]{0,18}$/.test(raw) || BigInt(raw) >= 2n ** 64n) {
      fail("invalid_request", "startAtMs is required: a positive integer number of milliseconds");
    }
    if (!MODES.includes(r.mode as ScoringMode)) fail("invalid_request", "mode is not a scoring mode");
    if (typeof r.amount !== "string" || !/^[1-9][0-9]{0,38}$/.test(r.amount)) {
      fail("invalid_request", "amount must be a positive integer in base units");
    }
    return {
      kind: "create_battle",
      representation: account(r.representation, "representation"),
      amount: r.amount as string,
      mode: r.mode as ScoringMode,
      startAtMs: raw as string,
    };
  }
  if (r.kind === "prepay_storage") {
    if (typeof r.amountYocto !== "string" || !/^[1-9][0-9]{0,38}$/.test(r.amountYocto)) {
      fail("invalid_request", "amountYocto must be a positive integer number of yoctoNEAR");
    }
    if (BigInt(r.amountYocto as string) > BigInt(PREPAY_STORAGE_MAX_YOCTO)) fail("invalid_request", "amountYocto is above 10 NEAR");
    return { kind: "prepay_storage", amountYocto: r.amountYocto as string };
  }
  if (r.kind === "register_position") {
    const battleId = Number(r.battleId);
    const community = Number(r.community);
    if (!Number.isSafeInteger(battleId) || battleId < 1) fail("invalid_request", "battleId must be a positive integer");
    if (!Number.isSafeInteger(community) || community < 0 || community > 15) fail("invalid_request", "community must be 0 to 15");
    return { kind: "register_position", battleId, community };
  }
  if (r.kind === "deposit") {
    const battleId = Number(r.battleId);
    const community = Number(r.community);
    if (!Number.isSafeInteger(battleId) || battleId < 1) fail("invalid_request", "battleId must be a positive integer");
    if (!Number.isSafeInteger(community) || community < 0 || community > 15) fail("invalid_request", "community must be 0 to 15");
    const route = r.route === undefined ? "direct" : String(r.route);
    if (!routes.includes(route)) {
      fail(
        "unsupported_route",
        `funding route "${route}" is not supported on testnet; only ${routes.map((r) => `"${r}"`).join(" and ")} ${routes.length > 1 ? "are" : "is"}. Nothing was submitted.`,
      );
    }
    if (r.requestId !== undefined && (typeof r.requestId !== "string" || !HEX32.test(r.requestId) || /^0{64}$/.test(r.requestId))) {
      fail("invalid_request", "requestId must be 32 non-zero bytes of lowercase hex");
    }
    return {
      kind: "deposit",
      battleId,
      community,
      amount: amount(r.amount),
      route,
      ...(r.grant !== undefined ? { grant: validateGrant(r.grant) } : {}),
      ...(r.requestId !== undefined ? { requestId: r.requestId as string } : {}),
    };
  }
  if (typeof r.destination !== "string" || !EVM.test(r.destination) || /^0x0{40}$/i.test(r.destination)) {
    fail("invalid_request", "destination must be a non-zero 20-byte hex address");
  }
  if (r.requestId !== undefined && (typeof r.requestId !== "string" || !HEX32.test(r.requestId) || /^0{64}$/.test(r.requestId))) {
    fail("invalid_request", "requestId must be 32 non-zero bytes of lowercase hex");
  }
  return {
    kind: "payout",
    backing: account(r.backing, "backing"),
    amount: amount(r.amount),
    destination: (r.destination as string).toLowerCase(),
    ...(r.requestId !== undefined ? { requestId: r.requestId as string } : {}),
    ...(r.grant !== undefined ? { grant: validateGrant(r.grant) } : {}),
  };
}

/** Grant pre-check from the public views; the contract's `reserve` re-checks the full scope. */
async function checkGrant(
  source: ActionReadSource,
  grant: GrantRequest,
  caller: string,
  value: bigint,
  gasUnits: bigint,
  nowMs: number,
): Promise<{ version: string }> {
  const localId = hexBytes(grant.localId);
  const view = await source.grant(grant.user, localId);
  if (!view) return fail("grant_invalid", "no grant exists for this user and local id");
  if (view.delegate !== caller) fail("grant_invalid", "the caller is not the grant's delegate");
  if (view.revoked) fail("grant_invalid", "the grant is revoked");
  if (BigInt(view.expiry_ns) <= BigInt(nowMs) * 1_000_000n) fail("grant_invalid", "the grant has expired");
  if (value > BigInt(view.per_action_cap)) fail("grant_invalid", "the amount exceeds the grant's per-action cap");
  if (gasUnits > BigInt(view.gas_cap)) fail("grant_invalid", "the gas exceeds the grant's gas cap");
  const budget = await source.budget(grant.user, localId);
  if (!budget || value > BigInt(budget.available)) fail("grant_invalid", "the grant's remaining budget is too small");
  return { version: view.version };
}

/**
 * Builds the canonical preview for `request` from fresh reads. `caller` is the verified session
 * account. The same function revalidates: it is called again before signing and its binding hash
 * must not change.
 */
export async function buildPreview(
  request: ActionRequest,
  caller: string,
  source: ActionReadSource,
  ctx: PreviewContext,
  nowMs: number,
): Promise<Preview> {
  const limitations: string[] = [
    "a preview is not a transaction; nothing moves until the signer signs the prepared transaction",
    "a broadcast transaction stays pending until its receipt is verified",
  ];
  const base: Pick<Preview, "version" | "network" | "createdAtMs" | "expiresAtMs" | "source"> = { version: ACTION_POLICY_VERSION, network: ctx.network, createdAtMs: nowMs, expiresAtMs: nowMs + PREVIEW_TTL_MS, source: source.info.kind };

  if (request.kind === "prepay_storage") {
    const prepayGas = gas(30n);
    return {
      ...base,
      kind: "prepay_storage",
      accountId: caller,
      signerId: caller,
      authorization: "user_signature",
      binding: { arena: ctx.arena, amountYocto: request.amountYocto },
      costs: { attachedDepositYocto: request.amountYocto, gasTgas: "30", notes: ["prepaid NEAR pays the storage of battles you create; it is not a bond and you can withdraw the unused part"] },
      transaction: {
        signerId: caller,
        receiverId: ctx.arena,
        actions: [{ type: "FunctionCall", methodName: "lifecycle_storage_deposit", args: {}, gas: prepayGas, deposit: request.amountYocto }],
      },
      limitations: [...limitations, "nothing in the prepaid balance is slashed; the arena deducts only the measured storage of battles you create"],
    };
  }

  if (request.kind === "create_battle") {
    const start = BigInt(request.startAtMs);
    if (start < BigInt(nowMs) + BigInt(MIN_START_LEAD_MS) || start > BigInt(nowMs) + BigInt(MAX_START_LEAD_MS)) {
      fail("invalid_request", "startAtMs must be between 1 minute and 7 days from now");
    }
    const asset = await source.joinableAsset(request.representation);
    if (!asset) return fail("not_joinable", `${request.representation} is not on the joinable-asset allowlist`);
    const balance = await source.tokenBalance(request.representation, caller);
    if (balance < BigInt(request.amount)) fail("insufficient_balance", "the representation balance is lower than the amount");
    const prepaid = await source.storageBalance(caller);
    if (prepaid < BigInt(CREATE_STORAGE_MIN_YOCTO)) {
      fail("storage_balance_low", "prepay storage on the arena first (prepay_storage): the prepaid balance cannot cover a new battle");
    }
    const msg = JSON.stringify({ action: "lifecycle_create", mode: request.mode, start_at_ms: request.startAtMs });
    const transferGas = 100n * TGAS;
    return {
      ...base,
      kind: "create_battle",
      accountId: caller,
      signerId: caller,
      authorization: "user_signature",
      binding: {
        arena: ctx.arena,
        representation: request.representation,
        amount: request.amount,
        mode: request.mode,
        startAtMs: request.startAtMs,
        asset: { chainId: asset.chain_id, tokenAddress: asset.token_address, representation: asset.representation, custodyDomain: asset.custody_domain },
      },
      costs: { attachedDepositYocto: ONE_YOCTO, gasTgas: "100", notes: ["one yocto is required by ft_transfer_call", "the creation storage is paid from your prepaid arena balance"] },
      transaction: {
        signerId: caller,
        receiverId: request.representation,
        actions: [{ type: "FunctionCall", methodName: "ft_transfer_call", args: { receiver_id: ctx.arena, amount: request.amount, msg }, gas: transferGas.toString(), deposit: ONE_YOCTO }],
      },
      limitations: [
        ...limitations,
        "the arena re-checks the allowlist, the start window and the prepaid storage when the transaction executes; a refused creation returns your tokens",
        `the battle starts at ${new Date(Number(start)).toISOString()}; your deposit is held in escrow until the audit and backing approvals of your token exist, and the battle cannot lock before then`,
        "with a start time the arena can be cancelled and deposits refunded when fewer than 2 communities are funded at the start",
      ],
    };
  }

  if (request.kind === "register_position") {
    const battle = await source.battle(request.battleId);
    if (!battle) return fail("battle_not_found", `battle ${request.battleId} not found`);
    if (battle.cancelled) fail("battle_cancelled", "the battle was cancelled; positions can no longer be registered");
    if (battle.locked) fail("battle_locked", "the battle is locked; positions can no longer be registered");
    if (battle.start_at_ms && BigInt(battle.start_at_ms) <= BigInt(nowMs)) fail("battle_started", "the start time has passed; positions can no longer be registered");
    const community = battle.communities[request.community];
    if (!community) return fail("invalid_request", `battle ${request.battleId} has no community ${request.community}`);
    const position = await source.position(request.battleId, request.community, caller);
    if (position.registered) fail("already_registered", "this account already has a position in this community");
    return {
      ...base,
      kind: "register_position",
      accountId: caller,
      signerId: caller,
      authorization: "user_signature",
      binding: { arena: ctx.arena, battleId: request.battleId, community: request.community },
      costs: { attachedDepositYocto: REGISTER_DEPOSIT_YOCTO, gasTgas: "30", notes: ["storage payment only, not a stake: the arena keeps actual storage and refunds the rest", "a deposit needs a registered position first"] },
      transaction: {
        signerId: caller,
        receiverId: ctx.arena,
        actions: [{ type: "FunctionCall", methodName: "register_lifecycle_position", args: { battle_id: request.battleId, community: request.community }, gas: gas(30n), deposit: REGISTER_DEPOSIT_YOCTO }],
      },
      limitations: [...limitations, "registering moves no tokens; the position is credited only after a deposit is accepted"],
    };
  }

  const lifecycle = await buildLifecyclePreview(request, caller, source, ctx, nowMs, base, limitations);
  if (lifecycle) return lifecycle;

  if (request.kind !== "deposit" && request.kind !== "payout") return fail("invalid_request", "unsupported action kind");
  const user = request.grant ? request.grant.user : caller;
  const value = BigInt(request.amount);

  if (request.kind === "deposit") {
    const battle = await source.battle(request.battleId);
    if (!battle) return fail("battle_not_found", `battle ${request.battleId} not found`);
    if (battle.cancelled) fail("battle_cancelled", "the battle was cancelled; deposits are closed (claim a refund instead)");
    if (battle.locked) fail("battle_locked", "the battle is locked; deposits are closed");
    if (battle.start_at_ms && BigInt(battle.start_at_ms) <= BigInt(nowMs)) fail("battle_started", "the start time has passed; deposits are closed");
    const community = battle.communities[request.community];
    if (!community) return fail("invalid_request", `battle ${request.battleId} has no community ${request.community}`);
    if (request.route === FIXTURE_ROUTE) {
      // Revalidation repeats this check, so a context that turned the fixture off rejects old previews.
      if (!ctx.intentsFixture) fail("unsupported_route", `funding route "${FIXTURE_ROUTE}" is not enabled in this configuration`);
      if (request.grant) fail("unsupported_route", `funding route "${FIXTURE_ROUTE}" is not available through a grant`);
      limitations.push(FIXTURE_LABEL);
    }
    if (!community.audit_evidence_hash) fail("audit_missing", "the community has no passing audit");
    if (!community.audit_expires_at_ms || BigInt(community.audit_expires_at_ms) <= BigInt(nowMs)) {
      fail("audit_expired", "the community's audit approval has expired");
    }
    if (!community.backing_evidence_hash) fail("backing_missing", "the community has no backing approval");
    const position = await source.position(request.battleId, request.community, user);
    if (!position.registered) fail("not_registered", "register a position in this community before depositing");
    const token = community.representation;
    const balance = await source.tokenBalance(token, user);
    if (balance < value) fail("insufficient_balance", "the representation balance is lower than the amount");
    const msg = JSON.stringify({ action: "lifecycle_deposit", battle_id: request.battleId, community: request.community });
    const binding = {
      arena: ctx.arena,
      battleId: request.battleId,
      community: request.community,
      asset: { chainId: community.chain_id, tokenAddress: community.token_address, representation: token, custodyDomain: community.custody_domain },
      auditEvidenceHash: community.audit_evidence_hash,
      backingEvidenceHash: community.backing_evidence_hash,
      amount: request.amount,
      route: request.route ?? "direct",
      ...(request.route === FIXTURE_ROUTE ? { fixture: true, fixtureLabel: FIXTURE_LABEL } : {}),
    };
    const transferGas = 100n * TGAS;
    if (request.grant) return grantPreview(base, request.grant, caller, source, ctx, nowMs, value, binding, {
      target: token,
      method: "ft_transfer_call",
      destination: ctx.arena,
      gasUnits: transferGas,
      requestId: request.requestId ?? fail("invalid_request", "a grant deposit needs a requestId"),
      battle: { battle_id: String(request.battleId), community: request.community },
      asset: community,
    }, "deposit", limitations);
    return {
      ...base,
      kind: "deposit",
      accountId: user,
      signerId: user,
      authorization: "user_signature",
      binding,
      costs: { attachedDepositYocto: ONE_YOCTO, gasTgas: "100", notes: ["one yocto is required by ft_transfer_call"] },
      transaction: {
        signerId: user,
        receiverId: token,
        actions: [{ type: "FunctionCall", methodName: "ft_transfer_call", args: { receiver_id: ctx.arena, amount: request.amount, msg }, gas: transferGas.toString(), deposit: ONE_YOCTO }],
      },
      limitations: [...limitations, "a deposit after lock is returned by the arena and credits nothing"],
    };
  }

  if (!ctx.payout) return fail("not_configured", "no payout contract is configured");
  const available = await source.entitlement(request.backing, user);
  if (available < value) fail("insufficient_entitlement", "the available entitlement is lower than the amount");
  const requestId = request.requestId as string;
  const binding = { payout: ctx.payout, backing: request.backing, amount: request.amount, destination: request.destination, requestId };
  const payoutGas = 150n * TGAS;
  if (request.grant) return grantPreview(base, request.grant, caller, source, ctx, nowMs, value, binding, {
    target: ctx.payout,
    method: "request_payout",
    destination: request.destination,
    gasUnits: payoutGas,
    requestId,
    battle: null,
    asset: null,
    backing: request.backing,
  }, "payout", limitations);
  return {
    ...base,
    kind: "payout",
    accountId: user,
    signerId: user,
    authorization: "user_signature",
    binding,
    costs: { attachedDepositYocto: PAYOUT_REQUEST_DEPOSIT_YOCTO, gasTgas: "150", notes: ["request storage deposit; unused part refunded"] },
    transaction: {
      signerId: user,
      receiverId: ctx.payout,
      actions: [
        {
          type: "FunctionCall",
          methodName: "request_payout",
          args: { backing: request.backing, request_id: hexBytes(requestId), amount: request.amount, destination: hexBytes(request.destination.slice(2)) },
          gas: payoutGas.toString(),
          deposit: PAYOUT_REQUEST_DEPOSIT_YOCTO,
        },
      ],
    },
    limitations: [...limitations, "available, reserved, broadcast, pending and confirmed payout states are reported separately"],
  };
}

interface GrantTarget {
  target: string;
  method: string;
  destination: string;
  gasUnits: bigint;
  requestId: string;
  battle: { battle_id: string; community: number } | null;
  asset: { chain_id: string; token_address: string; representation: string; custody_domain: string } | null;
  backing?: string;
}

/**
 * A grant-authorized action prepares only the delegate's `player-policy.reserve` call, bound to
 * the canonical action. The contract checks the full grant scope atomically; executing the
 * reserved action is the player-agent integration (#77).
 */
async function grantPreview(
  base: Pick<Preview, "version" | "network" | "createdAtMs" | "expiresAtMs" | "source">,
  grant: GrantRequest,
  caller: string,
  source: ActionReadSource,
  ctx: PreviewContext,
  nowMs: number,
  value: bigint,
  binding: Record<string, unknown>,
  target: GrantTarget,
  kind: "deposit" | "payout",
  limitations: string[],
): Promise<Preview> {
  if (!ctx.policy) return fail("not_configured", "no player-policy contract is configured");
  if (kind === "payout") return fail("invalid_request", "a payout through a grant needs the asset identity of the backing; use a user signature");
  const { version } = await checkGrant(source, grant, caller, value, target.gasUnits, nowMs);
  const asset = target.asset as NonNullable<GrantTarget["asset"]>;
  const action = {
    user: grant.user,
    local_id: hexBytes(grant.localId),
    version,
    asset: { chain_id: asset.chain_id, token: asset.token_address, representation: asset.representation, custody_domain: asset.custody_domain, mapping_version: grant.mappingVersion },
    target: target.target,
    method: target.method,
    destination: target.destination,
    amount: value.toString(),
    gas: target.gasUnits.toString(),
    request_id: hexBytes(target.requestId),
    battle: target.battle,
  };
  return {
    ...base,
    kind,
    accountId: grant.user,
    signerId: caller,
    authorization: "grant",
    binding: { ...binding, grant: { user: grant.user, localId: grant.localId, version, delegate: caller }, action },
    costs: { attachedDepositYocto: RESERVE_DEPOSIT_YOCTO, gasTgas: "30", notes: ["reservation storage deposit; unused part refunded", "a reservation moves no tokens"] },
    transaction: {
      signerId: caller,
      receiverId: ctx.policy,
      actions: [{ type: "FunctionCall", methodName: "reserve", args: { action }, gas: (30n * TGAS).toString(), deposit: RESERVE_DEPOSIT_YOCTO }],
    },
    limitations: [...limitations, "a grant reservation is budget authorization only; executing the reserved action is not part of this boundary"],
  };
}

export const previewHash = (preview: Preview): string => hashCanonical(preview);

/** Everything a user approves except the timestamps. */
export const bindingHash = (preview: Preview): string => {
  const { createdAtMs: _c, expiresAtMs: _e, limitations: _l, source: _s, ...bound } = preview;
  return hashCanonical(bound);
};
