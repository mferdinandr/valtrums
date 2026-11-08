import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import type { Nep413Verifier } from "../session.js";
import { sha256Hex } from "./canonical.js";
import {
  ActionError,
  type ActionRequest,
  type PreviewContext,
  type UnsignedTransaction,
  bindingHash,
  buildPreview,
  previewHash,
  validateRequest,
} from "./preview.js";
import type { ReceiptVerifier } from "./receipt.js";
import type { ActionReadSource } from "./source.js";
import type { ActionRecord, ActionStatus, ActionStore } from "./store.js";

/**
 * The single authorization and status boundary for actions, shared by the MCP tools and the web
 * terminal. It never signs or sends: it builds canonical previews, binds an authorization to the
 * exact preview hash, revalidates against fresh state before handing out the unsigned transaction,
 * and tracks the action until a verified receipt. The user's wallet (or a grant delegate's own
 * key, for a reservation) is the only signer.
 *
 * Lifecycle: previewed -> authorized -> ready_to_sign -> broadcast -> confirmed | failed.
 * Any step may end in `expired` (preview older than its expiry before preparation) or `rejected`
 * (state, amount, recipient or policy changed, or the grant no longer allows it).
 */

/** The fixed NEP-413 message a user signs to approve one exact preview. */
export const actionAuthorizationMessage = (hash: string): string =>
  `Authorize Valtrum action ${hash}. This approves only this exact preview until it expires.`;

export interface UserSignatureProof {
  kind: "user_signature";
  accountId: string;
  publicKey: string;
  /** Base64 signature over the NEP-413 payload. */
  signature: string;
  /** Base64 of the 32-byte nonce (first 8 bytes: big-endian ms timestamp). */
  nonce: string;
}
export interface GrantProof {
  kind: "grant";
}
export type AuthorizationProof = UserSignatureProof | GrantProof;

export class ActionAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionAccessError";
  }
}

export interface ActionServiceDeps {
  source: ActionReadSource;
  ctx: PreviewContext;
  store: ActionStore;
  verify: Nep413Verifier;
  /** NEP-413 recipient (the action service identity). */
  recipient: string;
  receipts: ReceiptVerifier;
  now?: () => number;
  maxNonceAgeMs?: number;
}

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const ACTION_ID = /^act_[0-9a-f]{32}$/;

export class ActionService {
  private readonly now: () => number;
  private readonly maxNonceAgeMs: number;
  private readonly usedNonces = new Map<string, number>();

  constructor(private readonly deps: ActionServiceDeps) {
    if (!deps.recipient.trim()) throw new Error("action service recipient is required");
    this.now = deps.now ?? Date.now;
    this.maxNonceAgeMs = deps.maxNonceAgeMs ?? 5 * 60 * 1000;
  }

  /** Validates the request, reads fresh state and stores a canonical preview. */
  async preview(caller: string, raw: unknown): Promise<ActionRecord> {
    const request = this.assignIds(validateRequest(raw));
    const nowMs = this.now();
    const preview = await buildPreview(request, caller, this.deps.source, this.deps.ctx, nowMs);
    const hash = previewHash(preview);
    const actionId = `act_${sha256Hex(`${hash}:${caller}`).slice(0, 32)}`;
    return this.deps.store.update(actionId, (current) => {
      if (current) throw new ActionError("invalid_request", "this preview already exists");
      return {
        actionId,
        caller,
        request,
        preview,
        previewHash: hash,
        bindingHash: bindingHash(preview),
        status: "previewed",
        authorization: null,
        txHash: null,
        reason: null,
        history: [{ status: "previewed", atMs: nowMs }],
      };
    });
  }

  /** Binds a user signature (NEP-413 over the preview hash) or the grant delegate to the action. */
  async authorize(actionId: string, caller: string, proof: AuthorizationProof): Promise<ActionRecord> {
    const record = await this.owned(actionId, caller);
    const nowMs = this.now();
    if (record.status !== "previewed") throw new ActionError("invalid_request", `cannot authorize an action that is ${record.status}`);
    if (nowMs >= record.preview.expiresAtMs) return this.transition(actionId, "expired", "the preview expired before authorization");
    if (proof?.kind === "grant") {
      if (record.preview.authorization !== "grant") throw new ActionAccessError("this action needs the user's signature");
      if (caller !== record.preview.signerId) throw new ActionAccessError("only the grant delegate can authorize through the grant");
      return this.deps.store.update(actionId, (r) => this.advance(r, "authorized", nowMs, undefined, {
        kind: "grant",
        delegate: caller,
        user: record.preview.accountId,
        atMs: nowMs,
      }));
    }
    if (proof?.kind !== "user_signature") throw new ActionAccessError("authorization proof is missing");
    if (record.preview.authorization !== "user_signature") throw new ActionAccessError("this action is authorized through a grant");
    if (proof.accountId !== record.preview.accountId) throw new ActionAccessError("the signature must come from the account whose funds move");
    await this.verifySignature(proof, record.previewHash, nowMs);
    return this.deps.store.update(actionId, (r) => this.advance(r, "authorized", nowMs, undefined, {
      kind: "user_signature",
      accountId: proof.accountId,
      publicKey: proof.publicKey,
      atMs: nowMs,
    }));
  }

  /**
   * Revalidates the authorized preview against fresh state (balances, audit, lock and round
   * state, grant scope) and returns the unsigned transaction for the signer's own wallet. A change
   * in anything the user approved rejects the action; the user must preview again.
   */
  async prepare(actionId: string, caller: string): Promise<{ record: ActionRecord; transaction: UnsignedTransaction }> {
    const record = await this.owned(actionId, caller);
    const nowMs = this.now();
    if (record.status !== "authorized" && record.status !== "ready_to_sign") {
      throw new ActionError("invalid_request", `cannot prepare an action that is ${record.status}`);
    }
    if (!record.authorization) throw new ActionAccessError("the action is not authorized");
    if (record.status === "authorized" && nowMs >= record.preview.expiresAtMs) {
      return { record: await this.transition(actionId, "expired", "the preview expired before preparation"), transaction: record.preview.transaction };
    }
    let fresh;
    try {
      fresh = await buildPreview(record.request, record.caller, this.deps.source, this.deps.ctx, nowMs);
    } catch (err) {
      if (err instanceof ActionError) {
        await this.transition(actionId, "rejected", `revalidation failed: ${err.message}`);
      }
      throw err;
    }
    if (bindingHash(fresh) !== record.bindingHash) {
      await this.transition(actionId, "rejected", "state, amount, recipient or policy changed since the preview; preview again");
      throw new ActionError("invalid_request", "the action changed since it was authorized; preview again");
    }
    const updated =
      record.status === "ready_to_sign" ? record : await this.deps.store.update(actionId, (r) => this.advance(r, "ready_to_sign", nowMs));
    return { record: updated, transaction: record.preview.transaction };
  }

  /** Records the hash the signer's wallet broadcast. It stays pending until a verified receipt. */
  async reportBroadcast(actionId: string, caller: string, txHash: string): Promise<ActionRecord> {
    if (typeof txHash !== "string" || !TX_HASH.test(txHash)) throw new ActionError("invalid_request", "txHash must be a base58 NEAR transaction hash");
    const record = await this.owned(actionId, caller);
    if (record.status === "broadcast" && record.txHash === txHash) return record;
    if (record.status !== "ready_to_sign") throw new ActionError("invalid_request", `cannot record a broadcast for an action that is ${record.status}`);
    const nowMs = this.now();
    return this.deps.store.update(actionId, (r) => ({ ...this.advance(r, "broadcast", nowMs, "pending until a verified receipt"), txHash }));
  }

  /** Checks the receipt of a broadcast action; only a matching final success confirms it. */
  async refresh(actionId: string, caller: string): Promise<ActionRecord> {
    const record = await this.owned(actionId, caller);
    if (record.status !== "broadcast" || !record.txHash) return record;
    const outcome = await this.deps.receipts.check(record.txHash, record.preview.transaction);
    if (outcome.status === "pending") return record;
    const nowMs = this.now();
    return this.deps.store.update(actionId, (r) =>
      outcome.status === "success"
        ? this.advance(r, "confirmed", nowMs, "verified final receipt")
        : { ...this.advance(r, "failed", nowMs, outcome.reason), reason: outcome.reason },
    );
  }

  async status(actionId: string, caller: string): Promise<ActionRecord> {
    const record = await this.owned(actionId, caller);
    if ((record.status === "previewed" || record.status === "authorized") && this.now() >= record.preview.expiresAtMs) {
      return this.transition(actionId, "expired", "the preview expired");
    }
    return record;
  }

  private assignIds(request: ActionRequest): ActionRequest {
    if (request.kind === "payout" && !request.requestId) return { ...request, requestId: bytesToHex(randomBytes(32)) };
    if (request.kind === "deposit" && request.grant && !request.requestId) return { ...request, requestId: bytesToHex(randomBytes(32)) };
    return request;
  }

  private async owned(actionId: string, caller: string): Promise<ActionRecord> {
    if (typeof actionId !== "string" || !ACTION_ID.test(actionId)) throw new ActionError("invalid_request", "unknown action");
    const record = await this.deps.store.get(actionId);
    if (!record) throw new ActionError("invalid_request", "unknown action");
    // Only the session that previewed it (the user, or the grant delegate) may drive it.
    if (record.caller !== caller) throw new ActionAccessError("this action belongs to another account");
    return record;
  }

  private advance(
    record: ActionRecord | null,
    status: ActionStatus,
    atMs: number,
    note?: string,
    authorization?: ActionRecord["authorization"],
  ): ActionRecord {
    if (!record) throw new ActionError("invalid_request", "unknown action");
    return {
      ...record,
      status,
      ...(authorization ? { authorization } : {}),
      history: [...record.history, { status, atMs, ...(note ? { note } : {}) }],
    };
  }

  private transition(actionId: string, status: "expired" | "rejected", reason: string): Promise<ActionRecord> {
    const nowMs = this.now();
    return this.deps.store.update(actionId, (r) => ({ ...this.advance(r, status, nowMs, reason), reason }));
  }

  private async verifySignature(proof: UserSignatureProof, hash: string, nowMs: number): Promise<void> {
    if (typeof proof.publicKey !== "string" || typeof proof.signature !== "string" || typeof proof.nonce !== "string") {
      throw new ActionAccessError("malformed authorization");
    }
    const nonce = new Uint8Array(Buffer.from(proof.nonce, "base64"));
    if (nonce.length !== 32) throw new ActionAccessError("nonce must be 32 bytes");
    const issued = Number(new DataView(nonce.buffer, nonce.byteOffset, 8).getBigUint64(0, false));
    if (nowMs - issued > this.maxNonceAgeMs || issued - nowMs > 30_000) throw new ActionAccessError("nonce expired or from the future");
    for (const [k, until] of this.usedNonces) if (until < nowMs) this.usedNonces.delete(k);
    const key = bytesToHex(nonce);
    if (this.usedNonces.has(key)) throw new ActionAccessError("nonce already used");
    let ok = false;
    try {
      ok = await this.deps.verify(
        { accountId: proof.accountId, publicKey: proof.publicKey, signature: proof.signature },
        { message: actionAuthorizationMessage(hash), recipient: this.deps.recipient, nonce },
      );
    } catch {
      ok = false;
    }
    if (!ok) throw new ActionAccessError("signature is not from a full-access key of this account over this preview");
    this.usedNonces.set(key, issued + this.maxNonceAgeMs);
  }
}
