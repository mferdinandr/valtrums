import { ActionError, type ActionRequest, type GrantRequest } from "./preview.js";

/**
 * Player-agent proposals (#77). Output of a NEAR AI player agent, and any token metadata it read,
 * is untrusted text. It can only *propose* a deposit by naming a user, battle, community and
 * amount; everything that decides where funds go (token, recipient, route, grant, request id,
 * signer) comes from chain state and the delegate's configuration, never from the proposal.
 * The proposal then goes through the same preview, grant and revalidation path as any action, so
 * it can never widen the user's grant: the per-action cap, budget, expiry and revocation are
 * checked by the views at preview and prepare time and again by the contract's `reserve`.
 */

/** Grants a delegate may act under, configured by the operator of that agent (not by a model). */
export type DelegateGrants = Readonly<Record<string, readonly GrantRequest[]>>;

const PROPOSAL_KEYS = new Set(["action", "user", "battleId", "community", "amount", "rationale"]);
const MAX_PROPOSAL_CHARS = 4_000;
const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n```$/;

const ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;

/**
 * Operator configuration `{"<delegate>": [{"user", "localId", "mappingVersion"}]}` (env
 * `PLAYER_AGENT_GRANTS`). Throws on anything malformed so a bad config fails at startup.
 */
export function parseDelegateGrants(raw: string | undefined): DelegateGrants {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PLAYER_AGENT_GRANTS must be JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PLAYER_AGENT_GRANTS must be an object");
  const out: Record<string, GrantRequest[]> = {};
  for (const [delegate, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ACCOUNT.test(delegate) || !Array.isArray(list)) throw new Error("PLAYER_AGENT_GRANTS maps a delegate account to a list");
    out[delegate] = list.map((g: Record<string, unknown>) => {
      if (
        typeof g?.user !== "string" ||
        !ACCOUNT.test(g.user) ||
        typeof g.localId !== "string" ||
        !/^[0-9a-f]{64}$/.test(g.localId) ||
        typeof g.mappingVersion !== "string" ||
        !/^[0-9]{1,19}$/.test(g.mappingVersion)
      ) {
        throw new Error("PLAYER_AGENT_GRANTS entries need user, a 32-byte hex localId and a decimal mappingVersion");
      }
      return { user: g.user, localId: g.localId, mappingVersion: g.mappingVersion };
    });
  }
  return out;
}

/**
 * Parses model output deterministically: the whole text must be one JSON object (optionally in a
 * single ```json fence). No free-text extraction, no partial parsing, no defaults that a model
 * could rely on to sneak in a field.
 */
export function parseProposal(output: unknown): Record<string, unknown> {
  let value: unknown = output;
  if (typeof output === "string") {
    if (output.length > MAX_PROPOSAL_CHARS) throw new ActionError("invalid_request", "proposal is too long");
    const text = output.trim();
    const fenced = FENCE.exec(text);
    try {
      value = JSON.parse(fenced ? (fenced[1] as string) : text);
    } catch {
      throw new ActionError("invalid_request", "proposal must be a single JSON object");
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ActionError("invalid_request", "proposal must be a single JSON object");
  }
  return value as Record<string, unknown>;
}

/**
 * Turns an untrusted proposal from `delegate` into an action request. Only a deposit for a user
 * this delegate holds a configured grant for is accepted; any other field (recipient, token,
 * route, grant, request id, a second action...) rejects the whole proposal rather than being
 * silently dropped, so a model cannot probe for fields that change the action.
 */
export function proposalToRequest(output: unknown, delegate: string, grants: DelegateGrants): ActionRequest {
  const p = parseProposal(output);
  for (const k of Object.keys(p)) {
    if (!PROPOSAL_KEYS.has(k)) throw new ActionError("invalid_request", `proposal field "${k}" is not allowed`);
  }
  if (p.action !== "deposit") throw new ActionError("invalid_request", "a player agent can only propose a deposit");
  if (p.rationale !== undefined && (typeof p.rationale !== "string" || p.rationale.length > 1_000)) {
    throw new ActionError("invalid_request", "rationale must be short text");
  }
  const grant = (grants[delegate] ?? []).find((g) => g.user === p.user);
  if (!grant) throw new ActionError("grant_invalid", "this agent holds no configured grant for that user");
  return {
    kind: "deposit",
    battleId: p.battleId as number,
    community: p.community as number,
    amount: p.amount as string,
    route: "direct",
    grant: { ...grant },
  };
}
