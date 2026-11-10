import type { CallReview } from "./create-review";

/**
 * Player-agent grants (OpenSpec `arena-player-agents`). A grant is created and revoked by the user's own wallet on
 * the `player-policy` contract: the funds stay in the user's account, the delegate (the agent's account) can only
 * `reserve` budget inside the grant's limits, and revocation is permanent per grant id. Nothing here moves tokens,
 * and executing a reservation is a separate, still open decision, so the UI says so.
 */

/** Storage deposit upper bound for `create_grant`; the contract refunds what it does not use. */
export const GRANT_STORAGE_DEPOSIT_YOCTO = "50000000000000000000000";
export const GRANT_GAS_TGAS = "30";
export const REVOKE_GAS_TGAS = "30";
/** The grant's own gas cap bound for one action; a UI choice, not a contract limit. */
export const MAX_ACTION_GAS_TGAS = 300;
/** Longest lifetime the form offers. The contract has no maximum yet (open decision in the OpenSpec). */
export const MAX_GRANT_DAYS = 90;

const TGAS = 1_000_000_000_000n;
const AMOUNT = /^[1-9][0-9]{0,38}$/;
const U64 = /^(0|[1-9][0-9]{0,19})$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const validAccount = (s: string): boolean => s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);

export interface GrantForm {
  /** The agent's NEAR account. It must differ from the user. */
  delegate: string;
  chainId: string;
  /** The source-chain token (20-byte EVM address) from the registry. */
  token: string;
  /** NEAR account of the NEP-141 representation. */
  representation: string;
  custodyDomain: string;
  mappingVersion: string;
  perAction: string;
  cumulative: string;
  days: string;
  gasCapTgas: string;
  /** Optional: restrict the grant to one battle. Empty means any battle. */
  battleId: string;
}

export const emptyGrantForm = (): GrantForm => ({
  delegate: "", chainId: "", token: "", representation: "", custodyDomain: "", mappingVersion: "1",
  perAction: "", cumulative: "", days: "7", gasCapTgas: "100", battleId: "",
});

export interface GrantContext {
  policy: string;
  arena: string;
  /** The connected account, or null when signed out. */
  user: string | null;
  nowMs: number;
  /** 32 random bytes chosen by the caller; kept so the grant can be found and revoked later. */
  localId: readonly number[];
}

export type GrantReview =
  | (Extract<{ ok: true } & CallReview, { ok: true }> & { localIdHex: string; expiresAtMs: number })
  | { ok: false; problems: string[] };

export const toHex = (bytes: readonly number[]): string => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
export const fromHex = (hex: string): number[] | null =>
  /^[0-9a-f]{64}$/.test(hex) ? Array.from({ length: 32 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)) : null;

export function randomLocalId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): number[] {
  return Array.from(random(32));
}

export function buildGrantReview(form: GrantForm, ctx: GrantContext): GrantReview {
  const problems: string[] = [];
  if (!validAccount(ctx.policy)) problems.push("the player-policy contract is not configured");
  if (!validAccount(ctx.arena)) problems.push("the arena contract id is not configured");
  if (!ctx.user) problems.push("connect your wallet first");
  if (!validAccount(form.delegate)) problems.push("the agent account must be a valid NEAR account id");
  else if (ctx.user && form.delegate === ctx.user) problems.push("the agent account must differ from your account");
  if (!U64.test(form.chainId) || BigInt(form.chainId) === 0n || BigInt(form.chainId) >= 2n ** 64n) problems.push("choose a token from the registry");
  if (!EVM.test(form.token)) problems.push("choose a token from the registry");
  if (!validAccount(form.representation)) problems.push("the representation must be a valid NEAR account id");
  if (!form.custodyDomain.trim() || form.custodyDomain.length > 64) problems.push("the custody domain is required (at most 64 characters)");
  if (!/^[1-9][0-9]{0,19}$/.test(form.mappingVersion)) problems.push("the mapping version must be a positive integer");
  const perOk = AMOUNT.test(form.perAction);
  const cumOk = AMOUNT.test(form.cumulative);
  if (!perOk) problems.push("the per-action limit must be a positive integer in token base units");
  if (!cumOk) problems.push("the total budget must be a positive integer in token base units");
  if (perOk && cumOk && BigInt(form.perAction) > BigInt(form.cumulative)) problems.push("the per-action limit cannot exceed the total budget");
  const days = Number(form.days);
  if (!/^[0-9]{1,3}$/.test(form.days) || days < 1 || days > MAX_GRANT_DAYS) problems.push(`the lifetime must be 1 to ${MAX_GRANT_DAYS} days`);
  const gas = Number(form.gasCapTgas);
  if (!/^[0-9]{1,3}$/.test(form.gasCapTgas) || gas < 1 || gas > MAX_ACTION_GAS_TGAS) problems.push(`the gas limit must be 1 to ${MAX_ACTION_GAS_TGAS} Tgas`);
  if (form.battleId !== "" && !/^[1-9][0-9]{0,19}$/.test(form.battleId)) problems.push("the battle id must be a positive integer or empty");
  if (ctx.localId.length !== 32 || ctx.localId.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) problems.push("the grant id is invalid");
  if (problems.length > 0) return { ok: false, problems };

  const expiresAtMs = ctx.nowMs + days * 86_400_000;
  const input = {
    delegate: form.delegate,
    local_id: [...ctx.localId],
    version: "1",
    asset: {
      chain_id: form.chainId,
      token: form.token.toLowerCase(),
      representation: form.representation,
      custody_domain: form.custodyDomain.trim(),
      mapping_version: form.mappingVersion,
    },
    contracts: [form.representation],
    methods: ["ft_transfer_call"],
    destinations: [ctx.arena],
    battle: form.battleId === "" ? null : { battle_id: form.battleId, community: null },
    per_action_cap: form.perAction,
    cumulative_cap: form.cumulative,
    gas_cap: (BigInt(gas) * TGAS).toString(),
    expiry_ns: (BigInt(expiresAtMs) * 1_000_000n).toString(),
  };
  const localIdHex = toHex(ctx.localId);
  return {
    ok: true,
    receiver: ctx.policy,
    method: "create_grant",
    args: { input },
    depositYocto: GRANT_STORAGE_DEPOSIT_YOCTO,
    gasTgas: GRANT_GAS_TGAS,
    localIdHex,
    expiresAtMs,
    lines: [
      { label: "Contract", value: ctx.policy },
      { label: "Method", value: "create_grant" },
      { label: "Agent account (delegate)", value: form.delegate },
      { label: "Token", value: `${form.chainId}:${form.token.toLowerCase()} · representation ${form.representation}` },
      { label: "Allowed call", value: `ft_transfer_call on ${form.representation}, destination ${ctx.arena}` },
      { label: "Per action", value: `${form.perAction} base units` },
      { label: "Total budget", value: `${form.cumulative} base units` },
      { label: "Gas per action", value: `${gas} Tgas` },
      { label: "Valid until", value: new Date(expiresAtMs).toISOString() },
      { label: "Scope", value: form.battleId === "" ? "any battle" : `battle #${form.battleId}` },
      { label: "Grant id", value: localIdHex },
      { label: "Storage deposit (upper bound)", value: `${GRANT_STORAGE_DEPOSIT_YOCTO} yoctoNEAR` },
    ],
    notes: [
      "Your tokens stay in your account. The agent can only reserve budget inside these limits; a reservation moves no tokens.",
      "You can revoke the grant at any time. Revocation is permanent for this grant id and blocks new reservations.",
      "Executing a reserved deposit is not enabled yet, so an agent cannot spend this budget on its own.",
      "The deposit is storage payment; the contract keeps the actual cost and refunds the rest.",
    ],
  };
}

/** The call that revokes a grant. One yoctoNEAR is required by the contract. */
export function buildRevokeReview(policy: string, localIdHex: string): ({ ok: true } & CallReview) | { ok: false; problems: string[] } {
  const id = fromHex(localIdHex);
  if (!validAccount(policy)) return { ok: false, problems: ["the player-policy contract is not configured"] };
  if (!id) return { ok: false, problems: ["the grant id is invalid"] };
  return {
    ok: true,
    receiver: policy,
    method: "revoke_grant",
    args: { local_id: id },
    depositYocto: "1",
    gasTgas: REVOKE_GAS_TGAS,
    lines: [
      { label: "Contract", value: policy },
      { label: "Method", value: "revoke_grant" },
      { label: "Grant id", value: localIdHex },
      { label: "Attached deposit", value: "1 yoctoNEAR (required)" },
    ],
    notes: ["Revocation is permanent for this grant id. Reservations that were already dispatched stay attributable."],
  };
}

/** `Tgas` string to the yocto-gas string wallets expect. */
export const gasUnits = (tgas: string): string => (BigInt(tgas) * TGAS).toString();

// ── Reading a grant back from the chain ─────────────────────────────────────────────────────────────────

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** A read-only `call_function` on a NEAR RPC. Returns the parsed JSON result, or null for a `null` result. */
export async function rpcView<T>(rpcUrl: string, contract: string, method: string, args: unknown, doFetch: FetchLike = (u, i) => fetch(u, i)): Promise<T | null> {
  const argsBase64 = btoa(JSON.stringify(args));
  const res = await doFetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "valtrum", method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: argsBase64 } }),
  });
  if (!res.ok) throw new Error(`RPC error ${res.status}`);
  const body = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { message?: string } };
  if (body.error || !body.result || body.result.error) throw new Error(body.result?.error ?? body.error?.message ?? "RPC read failed");
  const text = new TextDecoder().decode(new Uint8Array(body.result.result ?? []));
  return text ? (JSON.parse(text) as T | null) : null;
}

export interface GrantStatus {
  state: "active" | "revoked" | "expired" | "missing";
  delegate: string | null;
  perActionCap: string | null;
  cumulativeCap: string | null;
  gasCapTgas: string | null;
  expiresAtMs: number | null;
  budget: { authorizedLimit: string; consumed: string; reserved: string; available: string } | null;
}

interface GrantView { delegate: string; revoked: boolean; per_action_cap: string; cumulative_cap: string; gas_cap: string; expiry_ns: string }
interface BudgetView { authorized_limit: string; consumed: string; reserved: string; available: string }

/** Reads a grant and its budget. A missing grant is its own state, never an empty or zero one. */
export async function readGrantStatus(rpcUrl: string, policy: string, user: string, localIdHex: string, nowMs: number, doFetch?: FetchLike): Promise<GrantStatus> {
  const localId = fromHex(localIdHex);
  if (!localId) throw new Error("invalid grant id");
  const [grant, budget] = await Promise.all([
    rpcView<GrantView>(rpcUrl, policy, "get_grant", { user, local_id: localId }, doFetch),
    rpcView<BudgetView>(rpcUrl, policy, "get_budget", { user, local_id: localId }, doFetch),
  ]);
  if (!grant) return { state: "missing", delegate: null, perActionCap: null, cumulativeCap: null, gasCapTgas: null, expiresAtMs: null, budget: null };
  const expiresAtMs = Number(BigInt(grant.expiry_ns) / 1_000_000n);
  const state: GrantStatus["state"] = grant.revoked ? "revoked" : nowMs >= expiresAtMs ? "expired" : "active";
  return {
    state,
    delegate: grant.delegate,
    perActionCap: grant.per_action_cap,
    cumulativeCap: grant.cumulative_cap,
    gasCapTgas: (BigInt(grant.gas_cap) / TGAS).toString(),
    expiresAtMs,
    budget: budget ? { authorizedLimit: budget.authorized_limit, consumed: budget.consumed, reserved: budget.reserved, available: budget.available } : null,
  };
}

// ── Remembering grant ids in this browser ───────────────────────────────────────────────────────────────

export interface SavedGrant {
  localIdHex: string;
  createdAtMs: number;
  /** A display name such as the token symbol; never an identity. */
  label: string;
}

/** The contract has no "list my grants" view, so ids created here are remembered per account in this browser. */
export const savedGrantsKey = (account: string) => `valtrum:grants:${account}`;

export function parseSavedGrants(raw: string | null): SavedGrant[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (v): v is SavedGrant =>
        !!v && typeof v === "object" && typeof (v as SavedGrant).localIdHex === "string" && fromHex((v as SavedGrant).localIdHex) !== null &&
        Number.isFinite((v as SavedGrant).createdAtMs) && typeof (v as SavedGrant).label === "string",
    );
  } catch {
    return [];
  }
}

export const addSavedGrant = (list: readonly SavedGrant[], grant: SavedGrant): SavedGrant[] =>
  list.some((g) => g.localIdHex === grant.localIdHex) ? [...list] : [grant, ...list].slice(0, 50);
