// FIXTURE-ONLY harness: synthetic battles and balances, scripted receipts. Not live evidence.
import { verifyNep413Signature } from "near-kit";
import { ActionService, actionAuthorizationMessage } from "../../src/mcp/actions/service.js";
import type { ReceiptOutcome, ReceiptVerifier } from "../../src/mcp/actions/receipt.js";
import { FixtureActionReadSource } from "../../src/mcp/actions/source.js";
import { ActionStore } from "../../src/mcp/actions/store.js";
import { FULL_ACCESS_KEYS, NOW, RECIPIENT, battle, signRead } from "../mcp/fixtures.js";

export const REP = "pepe.rep.testnet";
export const key = FixtureActionReadSource.key;
export const baseCtx = { network: "near-testnet", arena: "arena.testnet", payout: "payout.testnet", policy: "policy.testnet" };

export class ScriptedReceipts implements ReceiptVerifier {
  next: ReceiptOutcome = { status: "pending", reason: "not final" };
  async check(): Promise<ReceiptOutcome> {
    return this.next;
  }
}

export function approvedBattle() {
  const b = battle();
  b.communities = b.communities.map((c) => ({
    ...c,
    audit_evidence_hash: "audit-hash",
    audit_expires_at_ms: String(NOW + 60 * 60_000),
    backing_evidence_hash: "backing-hash",
  }));
  return b;
}

export function makeActions(ctx: Record<string, unknown> = baseCtx, balance = 1_000n) {
  const source = new FixtureActionReadSource("near-testnet", {
    battles: new Map([[1, approvedBattle()]]),
    positions: new Map([[key(1, 0, "alice.testnet"), { registered: true, amount: "0" }]]),
    balances: new Map([[key(REP, "alice.testnet"), balance]]),
    entitlements: new Map(),
    grants: new Map(),
    budgets: new Map(),
  });
  const receipts = new ScriptedReceipts();
  const service = new ActionService({
    source,
    ctx: ctx as never,
    store: new ActionStore(null),
    recipient: RECIPIENT,
    receipts,
    now: () => NOW,
    verify: async (signed, params) =>
      FULL_ACCESS_KEYS.get(signed.accountId)?.has(signed.publicKey) === true && verifyNep413Signature(signed, params, { nonceValidation: "none" }),
  });
  return { source, service, receipts };
}

export const signFor = (hash: string, account = "alice.testnet") => ({
  kind: "user_signature" as const,
  ...signRead(account, { message: actionAuthorizationMessage(hash), at: NOW }),
});

export const deposit = (over: Record<string, unknown> = {}) => ({ kind: "deposit", battleId: 1, community: 0, amount: "100", ...over });
