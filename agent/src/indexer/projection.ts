import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { AcceptedEvent } from "./types.js";

/**
 * Pure, deterministic battle-activity projection over accepted events. Output depends only on the
 * events, their canonical order, the finalized height and the reducer version — never on the wall
 * clock, random ids, fetch batch size or duplicate delivery. State is namespaced by network and
 * contract, not battle id alone, so two networks/contracts cannot collide. The reducer infers
 * nothing absent from events: unknown history is explicit, an audit result is not proof of current
 * TTL validity, and a deposit credit is not a payout.
 */

export interface EventRef {
  dedupKey: string;
  blockHeight: string;
  blockHash: string;
  outcomeIndex: number;
  logIndex: number;
  itemIndex: number;
  /** Derived at projection time: the block is at or below the finalized height. */
  finalized: boolean;
}

export interface AuditEntry {
  community: string;
  result: "pass" | "reject" | "pending";
  evidenceHash: string;
  expiresAtMs: string | null;
  ref: EventRef;
}

export interface DepositEntry {
  community: string;
  accountId: string;
  amount: string;
  ref: EventRef;
}

export interface BackingEntry {
  approved: boolean;
  evidenceHash: string | null;
  expiresAtMs: string | null;
  ref: EventRef;
}

export interface LateDepositEntry {
  beneficiary: string;
  /** Source-chain refund address recorded by the backing contract; informational, never a payout. */
  refundAddress: string;
  units: string;
  ref: EventRef;
}

export interface BattleActivity {
  namespace: string;
  battleId: string;
  creator: string | null;
  created: EventRef | null;
  audits: AuditEntry[];
  deposits: DepositEntry[];
  /** Exact summed credited amount per community (decimal string). */
  creditedByCommunity: Record<string, string>;
  /** Deterministic latest audit per community (by canonical order). Not a current-validity claim. */
  latestAuditByCommunity: Record<string, { result: string; evidenceHash: string; expiresAtMs: string | null }>;
  /** Latest backing approval per community (canonical order). An approval is not current-TTL validity. */
  backings: Record<string, BackingEntry>;
  /** Late deposits recorded by a backing contract for this battle id. */
  lateDeposits: LateDepositEntry[];
  /** Every event reference for this battle, in canonical order. */
  activity: EventRef[];
}

export interface PayoutActivity {
  backing: string;
  holder: string;
  requestId: string;
  /** Last state label from `payout_state_changed`; only `confirmed` means paid, and only when finalized. */
  state: string | null;
  reason: string | null;
  signature: "requested" | "received" | "failed" | null;
  txHash: string | null;
  ref: EventRef;
}

/** State reported by one allowlisted emitter (arena, backing or payout contract), keyed by namespace. */
export interface ContractActivity {
  namespace: string;
  trustedRepresentations: Record<string, boolean>;
  suspension: { suspended: boolean; reasons: string[]; ref: EventRef | null };
  lastAttestation: { sequence: string; sourceBlockNumber: string; covered: boolean; balance: string; required: string | null; ref: EventRef } | null;
  operator: { value: string | null; ref: EventRef } | null;
  resumePolicy: { value: string; ref: EventRef } | null;
  payouts: Record<string, PayoutActivity>;
}

export interface Projection {
  reducerVersion: string;
  finalizedHeight: string;
  battles: Record<string, BattleActivity>;
  contracts: Record<string, ContractActivity>;
  digest: string;
}

const hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** Total canonical order: block height, then receipt, log and data-item position. */
export function canonicalCompare(a: AcceptedEvent, b: AcceptedEvent): number {
  const ap = a.provenance;
  const bp = b.provenance;
  const ah = BigInt(ap.blockHeight);
  const bh = BigInt(bp.blockHeight);
  if (ah !== bh) return ah < bh ? -1 : 1;
  if (ap.outcomeIndex !== bp.outcomeIndex) return ap.outcomeIndex - bp.outcomeIndex;
  if (ap.logIndex !== bp.logIndex) return ap.logIndex - bp.logIndex;
  if (ap.itemIndex !== bp.itemIndex) return ap.itemIndex - bp.itemIndex;
  return a.dedupKey < b.dedupKey ? -1 : a.dedupKey > b.dedupKey ? 1 : 0;
}

export interface BuildOptions {
  finalizedHeight: bigint;
  reducerVersion: string;
}

/**
 * Fold accepted events into the projection. Input may be in any order and may contain exact
 * duplicates (same dedupKey); both are normalized away before the deterministic fold.
 */
export function buildProjection(events: AcceptedEvent[], opts: BuildOptions): Projection {
  const byKey = new Map<string, AcceptedEvent>();
  for (const e of events) if (!byKey.has(e.dedupKey)) byKey.set(e.dedupKey, e);
  const ordered = [...byKey.values()].sort(canonicalCompare);

  const battles = new Map<string, BattleActivity>();
  const refOf = (e: AcceptedEvent): EventRef => ({
    dedupKey: e.dedupKey,
    blockHeight: e.provenance.blockHeight,
    blockHash: e.provenance.blockHash,
    outcomeIndex: e.provenance.outcomeIndex,
    logIndex: e.provenance.logIndex,
    itemIndex: e.provenance.itemIndex,
    finalized: BigInt(e.provenance.blockHeight) <= opts.finalizedHeight,
  });
  const battleOf = (e: AcceptedEvent & { battleId: string }): BattleActivity => {
    const namespace = `${e.provenance.network}|${e.provenance.contract}`;
    const key = `${namespace}|${e.battleId}`;
    let b = battles.get(key);
    if (!b) {
      b = {
        namespace,
        battleId: e.battleId,
        creator: null,
        created: null,
        audits: [],
        deposits: [],
        creditedByCommunity: {},
        latestAuditByCommunity: {},
        backings: {},
        lateDeposits: [],
        activity: [],
      };
      battles.set(key, b);
    }
    return b;
  };
  const contracts = new Map<string, ContractActivity>();
  const contractOf = (e: AcceptedEvent): ContractActivity => {
    const namespace = `${e.provenance.network}|${e.provenance.contract}`;
    let c = contracts.get(namespace);
    if (!c) {
      c = { namespace, trustedRepresentations: {}, suspension: { suspended: false, reasons: [], ref: null }, lastAttestation: null, operator: null, resumePolicy: null, payouts: {} };
      contracts.set(namespace, c);
    }
    return c;
  };
  const payoutOf = (c: ContractActivity, e: { backing: string; holder: string; requestId: string }, ref: EventRef): PayoutActivity => {
    const key = `${e.backing}|${e.holder}|${e.requestId}`;
    return (c.payouts[key] ??= { backing: e.backing, holder: e.holder, requestId: e.requestId, state: null, reason: null, signature: null, txHash: null, ref });
  };

  for (const e of ordered) {
    const ref = refOf(e);
    if ("battleId" in e) {
      const b = battleOf(e);
      b.activity.push(ref);
      if (e.name === "lifecycle_battle_created") {
        b.creator = e.creator;
        b.created = ref;
      } else if (e.name === "audit_updated") {
        b.audits.push({ community: e.community, result: e.result, evidenceHash: e.evidenceHash, expiresAtMs: e.expiresAtMs, ref });
        b.latestAuditByCommunity[e.community] = { result: e.result, evidenceHash: e.evidenceHash, expiresAtMs: e.expiresAtMs };
      } else if (e.name === "lifecycle_deposit") {
        b.deposits.push({ community: e.community, accountId: e.accountId, amount: e.amount, ref });
        const prev = b.creditedByCommunity[e.community];
        b.creditedByCommunity[e.community] = ((prev ? BigInt(prev) : 0n) + BigInt(e.amount)).toString();
      } else if (e.name === "backing_updated") {
        b.backings[e.community] = { approved: e.approved, evidenceHash: e.evidenceHash, expiresAtMs: e.expiresAtMs, ref };
      } else if (e.name === "late_deposit_recorded") {
        b.lateDeposits.push({ beneficiary: e.beneficiary, refundAddress: e.refundAddress, units: e.units, ref });
      }
      continue;
    }
    const c = contractOf(e);
    switch (e.name) {
      case "lifecycle_representation_trust_changed":
        c.trustedRepresentations[e.representation] = e.trusted;
        break;
      case "asset_suspended":
        c.suspension = { suspended: true, reasons: [...new Set([...c.suspension.reasons, e.reason])].sort(), ref };
        break;
      case "asset_resumed": {
        const reasons = c.suspension.reasons.filter((r) => !(e.reorg && r === "reorg") && !(e.deficit && r === "deficit"));
        c.suspension = { suspended: e.stillSuspended, reasons, ref };
        break;
      }
      case "reconciliation_unresolved":
        // The contract clears an unresolved reservation by a confirmation or release that emits no
        // event of this kind, so only the next `asset_resumed` can lift this in the projection.
        c.suspension = { suspended: true, reasons: [...new Set([...c.suspension.reasons, "unresolved"])].sort(), ref };
        break;
      case "custody_attested":
        c.lastAttestation = { sequence: e.sequence, sourceBlockNumber: e.sourceBlockNumber, covered: e.covered, balance: e.balance, required: e.required, ref };
        break;
      case "operator_changed":
        c.operator = { value: e.next, ref };
        break;
      case "resume_policy_changed":
        c.resumePolicy = { value: e.next, ref };
        break;
      case "payout_signature_requested": {
        const p = payoutOf(c, e, ref);
        p.signature = "requested";
        p.ref = ref;
        break;
      }
      case "payout_signature_received": {
        const p = payoutOf(c, e, ref);
        p.signature = "received";
        p.txHash = e.txHash;
        p.ref = ref;
        break;
      }
      case "payout_signature_failed": {
        const p = payoutOf(c, e, ref);
        p.signature = "failed";
        p.ref = ref;
        break;
      }
      case "payout_state_changed": {
        const p = payoutOf(c, e, ref);
        p.state = e.to;
        p.reason = e.reason;
        p.ref = ref;
        break;
      }
    }
  }

  const out: Record<string, BattleActivity> = {};
  for (const key of [...battles.keys()].sort()) out[key] = battles.get(key)!;
  const contractOut: Record<string, ContractActivity> = {};
  for (const key of [...contracts.keys()].sort()) contractOut[key] = contracts.get(key)!;
  const digest = hex(canonicalJson({ reducerVersion: opts.reducerVersion, finalizedHeight: opts.finalizedHeight.toString(), battles: out, contracts: contractOut }));
  return { reducerVersion: opts.reducerVersion, finalizedHeight: opts.finalizedHeight.toString(), battles: out, contracts: contractOut, digest };
}
