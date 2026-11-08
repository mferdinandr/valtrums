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
  /** Every event reference for this battle, in canonical order. */
  activity: EventRef[];
}

export interface Projection {
  reducerVersion: string;
  finalizedHeight: string;
  battles: Record<string, BattleActivity>;
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
  const battleOf = (e: AcceptedEvent): BattleActivity => {
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
        activity: [],
      };
      battles.set(key, b);
    }
    return b;
  };

  for (const e of ordered) {
    const b = battleOf(e);
    const ref = refOf(e);
    b.activity.push(ref);
    if (e.name === "lifecycle_battle_created") {
      b.creator = e.creator;
      b.created = ref;
    } else if (e.name === "audit_updated") {
      b.audits.push({ community: e.community, result: e.result, evidenceHash: e.evidenceHash, expiresAtMs: e.expiresAtMs, ref });
      b.latestAuditByCommunity[e.community] = { result: e.result, evidenceHash: e.evidenceHash, expiresAtMs: e.expiresAtMs };
    } else {
      b.deposits.push({ community: e.community, accountId: e.accountId, amount: e.amount, ref });
      const prev = b.creditedByCommunity[e.community];
      b.creditedByCommunity[e.community] = ((prev ? BigInt(prev) : 0n) + BigInt(e.amount)).toString();
    }
  }

  const out: Record<string, BattleActivity> = {};
  for (const key of [...battles.keys()].sort()) out[key] = battles.get(key)!;
  const digest = hex(canonicalJson({ reducerVersion: opts.reducerVersion, finalizedHeight: opts.finalizedHeight.toString(), battles: out }));
  return { reducerVersion: opts.reducerVersion, finalizedHeight: opts.finalizedHeight.toString(), battles: out, digest };
}
