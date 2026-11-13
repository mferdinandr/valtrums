import { type ReadEnvelope, envelope } from "../envelope.js";
import { SessionError } from "../session.js";
import { AccessDeniedError, type ReadToolDeps, ToolInputError } from "../tools.js";
import { ActionError } from "./preview.js";
import { ActionAccessError, type ActionService, type AuthorizationProof, actionAuthorizationMessage } from "./service.js";
import type { ActionRecord } from "./store.js";

/**
 * Action tools shared by MCP and the HTTP API used by the web terminal: one boundary, one status.
 * Every tool needs a read session; the caller is the session account. No tool signs or sends: the
 * signer's wallet does, using the transaction from `prepare_action`.
 */

export interface ActionToolDeps extends ReadToolDeps {
  actions?: ActionService;
}

type Args = Record<string, unknown>;

export interface ActionTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  run(
    args: Args,
    actions: ActionService,
    caller: string,
  ): Promise<ActionRecord | { record: ActionRecord; transaction?: unknown; attribution?: unknown }>;
}

const session = { session: { type: "string", description: "Read session token from open_read_session (NEP-413)." } };
const actionId = { actionId: { type: "string", description: "Durable action id from preview_action." } };

export const ACTION_TOOLS: readonly ActionTool[] = [
  {
    name: "preview_action",
    description:
      "Build a canonical, hashed preview of create_battle (a creator deposit: representation, amount, mode and a required startAtMs), prepay_storage, join_battle, cancel_battle, claim_refund, claim_escrow_refund, register_position, deposit, " +
      "payout, late_refund, settle_battle, reserve_escrow, vote_disposition, execute_disposition, request_dao_burn, claim_entitlement or register_representation for the session account (or, with a grant, " +
      "for the grant user with the session as delegate). Returns the action id, preview hash and expiry; moves nothing.",
    inputSchema: { type: "object", properties: { ...session, request: { type: "object" } }, required: ["session", "request"], additionalProperties: false },
    run: (args, actions, caller) => actions.preview(caller, args.request),
  },
  {
    name: "authorize_action",
    description:
      "Bind an authorization to one exact preview: a NEP-413 signature over the message " +
      `"${actionAuthorizationMessage("<previewHash>")}" from the funds' account, {kind:"session"} when the session's account owns the funds ` +
      "and signs the transaction itself, or {kind:\"grant\"} from the grant delegate. Authorizing moves nothing: only the account's wallet " +
      "signature on the prepared transaction does.",
    inputSchema: { type: "object", properties: { ...session, ...actionId, proof: { type: "object" } }, required: ["session", "actionId", "proof"], additionalProperties: false },
    run: (args, actions, caller) => actions.authorize(String(args.actionId), caller, args.proof as AuthorizationProof),
  },
  {
    name: "prepare_action",
    description:
      "Revalidate an authorized preview against fresh state (balances, audit, lock and round state, grant scope) and return the unsigned " +
      "transaction for the signer's own wallet. A changed or expired preview is rejected.",
    inputSchema: { type: "object", properties: { ...session, ...actionId }, required: ["session", "actionId"], additionalProperties: false },
    run: (args, actions, caller) => actions.prepare(String(args.actionId), caller),
  },
  {
    name: "report_broadcast",
    description: "Record the transaction hash the wallet broadcast. The action stays pending until its receipt is verified.",
    inputSchema: { type: "object", properties: { ...session, ...actionId, txHash: { type: "string" } }, required: ["session", "actionId", "txHash"], additionalProperties: false },
    run: (args, actions, caller) => actions.reportBroadcast(String(args.actionId), caller, String(args.txHash)),
  },
  {
    name: "action_status",
    description:
      "Read an action's durable status and attribution (user, signer, position, grant state, on-chain reservation). A broadcast action " +
      "is checked against its final receipt; a revoked grant rejects actions not yet prepared while prepared ones stay attributable.",
    inputSchema: { type: "object", properties: { ...session, ...actionId }, required: ["session", "actionId"], additionalProperties: false },
    run: async (args, actions, caller) => {
      await actions.status(String(args.actionId), caller);
      const record = await actions.refresh(String(args.actionId), caller);
      return { record, attribution: await actions.attribution(String(args.actionId), caller) };
    },
  },
  {
    name: "propose_action",
    description:
      "Player agents: submit model output as an untrusted proposal ({action:'deposit', user, battleId, community, amount, rationale?}). " +
      "It becomes a grant preview under this delegate's configured grant for that user; any other field rejects it. Moves nothing.",
    inputSchema: { type: "object", properties: { ...session, proposal: {} }, required: ["session", "proposal"], additionalProperties: false },
    run: (args, actions, caller) => actions.propose(caller, args.proposal),
  },
];

export const ACTION_TOOL_NAMES: readonly string[] = ACTION_TOOLS.map((t) => t.name);

export async function callActionTool(name: string, args: Args, deps: ActionToolDeps): Promise<ReadEnvelope<unknown>> {
  const tool = ACTION_TOOLS.find((t) => t.name === name);
  if (!tool) throw new ToolInputError(`unknown action tool: ${name}`);
  if (!deps.actions) throw new ToolInputError("actions are not configured on this service");
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new ToolInputError("arguments must be an object");
  const allowed = new Set(Object.keys(tool.inputSchema.properties));
  for (const k of Object.keys(args)) if (!allowed.has(k)) throw new ToolInputError(`unknown argument: ${k}`);
  let caller: string;
  try {
    caller = deps.sessions.accountOf(args.session);
  } catch (err) {
    throw new AccessDeniedError(err instanceof SessionError ? err.message : "invalid read session");
  }
  try {
    const result = await tool.run(args, deps.actions, caller);
    const nowMs = deps.now();
    const record = "record" in result ? result.record : result;
    return envelope(name, deps.arena.info, result, {
      observedAtMs: nowMs,
      nowMs,
      maxAgeMs: deps.maxAgeMs ?? 60_000,
      limitations: record.preview.limitations,
    });
  } catch (err) {
    if (err instanceof ActionError) throw new ToolInputError(`${err.code}: ${err.message}`);
    if (err instanceof ActionAccessError) throw new AccessDeniedError(err.message);
    throw err;
  }
}
