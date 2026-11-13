/**
 * Terminal path of the shared action boundary (#76). The terminal builds nothing it signs: the
 * agent action API (through `/api/arena/actions`) creates the canonical preview, binds the user's
 * own read session to it as the authorization, revalidates, and returns the exact unsigned transaction
 * for the wallet, whose signature is the only one per action. The MCP action tools use the same
 * service, so both paths share one authorization and status record. A broadcast hash stays pending
 * until the service verifies the receipt.
 */
import { forgetStoredSessions } from "@/lib/arena-read/action-session";

export interface UnsignedTransaction {
  signerId: string;
  receiverId: string;
  actions: { type: "FunctionCall"; methodName: string; args: Record<string, unknown>; gas: string; deposit: string }[];
}

export type ActionStatus = "previewed" | "authorized" | "ready_to_sign" | "broadcast" | "confirmed" | "failed" | "rejected" | "expired";

export interface ActionRecordView {
  actionId: string;
  previewHash: string;
  status: ActionStatus;
  reason: string | null;
  preview: { expiresAtMs: number; accountId: string; transaction: UnsignedTransaction; costs: unknown; binding: unknown };
}

/** The message a wallet signs (NEP-413) to approve one exact preview; mirrors the agent. */
export const actionAuthorizationMessage = (hash: string): string =>
  `Authorize Valtrum action ${hash}. This approves only this exact preview until it expires.`;

export interface ActionWallet {
  /** NEP-413 signature over `message` for `recipient` with a fresh 32-byte nonce (ms timestamp first). */
  signMessage(message: string): Promise<{ accountId: string; publicKey: string; signature: string; nonce: string }>;
  /** Signs and broadcasts exactly this transaction; returns its hash. */
  signAndSend(tx: UnsignedTransaction): Promise<string>;
}

export interface ActionClientDeps {
  session: string;
  wallet: ActionWallet;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  baseUrl?: string;
  /** Status polls after broadcast before reporting it as still pending. */
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The `intents-fixture` funding route (D29) is a local fixture of the 1Click API, never NEAR Intents.
 * Any result of an action bound to it carries `fixture` so every status surface can show the label.
 */
export const FIXTURE_FUNDING_ROUTE = "intents-fixture";

/** The fixture label of a preview binding, or null for a real (direct) route. */
export function fixtureNotice(binding: unknown): string | null {
  const b = binding as { route?: unknown; fixtureLabel?: unknown } | null;
  if (!b || b.route !== FIXTURE_FUNDING_ROUTE) return null;
  return typeof b.fixtureLabel === "string" ? b.fixtureLabel : "FIXTURE: local 1Click API fixture on testnet. Not NEAR Intents.";
}

export type ActionRunResult =
  | { ok: true; status: "confirmed"; actionId: string; txHash: string; fixture?: string }
  | { ok: false; status: ActionStatus | "error"; actionId: string | null; reason: string; txHash: string | null; fixture?: string };

async function call(deps: ActionClientDeps, path: string, method: "GET" | "POST", body?: unknown): Promise<ActionRecordView & { transaction?: UnsignedTransaction }> {
  const doFetch = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  const res = await doFetch(`${deps.baseUrl ?? "/api/arena/actions"}${path}`, {
    method,
    headers: { authorization: `Bearer ${deps.session}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; data?: unknown };
  if (!res.ok) {
    // A rejected session token must not be reused after a reload: the next action opens a fresh session.
    if ((res.status === 401 || res.status === 403) && /read session/i.test(json.error ?? "")) forgetStoredSessions();
    throw new Error(json.error ?? `action API error ${res.status}`);
  }
  const data = json.data as ActionRecordView | { record: ActionRecordView; transaction: UnsignedTransaction };
  return "record" in data ? { ...data.record, transaction: data.transaction } : data;
}

export interface PreviewedAction {
  record: ActionRecordView;
  fixture?: string;
}

/** Step 1: asks the service for the canonical preview. Nothing is signed or sent. */
export async function previewTerminalAction(request: Record<string, unknown>, deps: ActionClientDeps): Promise<PreviewedAction> {
  const record = await call(deps, "", "POST", { request });
  const notice = fixtureNotice(record.preview?.binding);
  return { record, ...(notice ? { fixture: notice } : {}) };
}

/** Steps 2 to 5: authorize the exact preview, prepare, sign and send, then wait for a verified receipt. */
export async function executeTerminalAction(previewed: PreviewedAction, deps: ActionClientDeps): Promise<ActionRunResult> {
  const actionId = previewed.record.actionId;
  let txHash: string | null = null;
  const label: { fixture?: string } = previewed.fixture ? { fixture: previewed.fixture } : {};
  try {
    // The read session (opened with the account's own wallet signature) authorizes the preview, so the
    // user is not asked to sign a second message per action. Nothing moves until the wallet signs the
    // prepared transaction below, and the service only accepts this when that account signs it itself.
    const authorized = await call(deps, `/${actionId}/authorize`, "POST", { proof: { kind: "session" } });
    if (authorized.status !== "authorized") return { ok: false, status: authorized.status, actionId, reason: authorized.reason ?? "not authorized", txHash, ...label };
    const prepared = await call(deps, `/${actionId}/prepare`, "POST", {});
    if (prepared.status !== "ready_to_sign" || !prepared.transaction) {
      return { ok: false, status: prepared.status, actionId, reason: prepared.reason ?? "not ready to sign", txHash, ...label };
    }
    txHash = await deps.wallet.signAndSend(prepared.transaction);
    let current = await call(deps, `/${actionId}/broadcast`, "POST", { txHash });
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let i = 0; i < (deps.maxPolls ?? 10) && current.status === "broadcast"; i++) {
      await sleep(2_000);
      current = await call(deps, `/${actionId}`, "GET");
    }
    if (current.status === "confirmed") return { ok: true, status: "confirmed", actionId, txHash, ...label };
    return {
      ok: false,
      status: current.status,
      actionId,
      txHash,
      ...label,
      reason: current.status === "broadcast" ? "broadcast; waiting for a verified receipt" : (current.reason ?? current.status),
    };
  } catch (err) {
    return { ok: false, status: "error", actionId, txHash, reason: err instanceof Error ? err.message : String(err), ...label };
  }
}

/** Runs one action end to end through the shared boundary. Nothing is signed before `prepare`. */
export async function runTerminalAction(request: Record<string, unknown>, deps: ActionClientDeps): Promise<ActionRunResult> {
  let previewed: PreviewedAction;
  try {
    previewed = await previewTerminalAction(request, deps);
  } catch (err) {
    return { ok: false, status: "error", actionId: null, txHash: null, reason: err instanceof Error ? err.message : String(err) };
  }
  return executeTerminalAction(previewed, deps);
}
