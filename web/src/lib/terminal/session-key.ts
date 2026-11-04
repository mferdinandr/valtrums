// Session keys: a scoped function-call access key so repeat deposits need no wallet prompt.
//
// Why `deposit_from_balance`: a NEAR function-call key cannot attach a deposit, and `ft_transfer_call` needs
// 1 yoctoNEAR, so USDC transfers always need the wallet. Instead the user funds the arena's internal balance once
// (one wallet approval) and the key may call `deposit_from_balance`, which needs no attached deposit.
//
// Real exposure of a leaked key: it can spend the funded balance (and unexpired credit) on deposits into open
// battles and burn its gas allowance. It cannot withdraw anything: `withdraw_liquid` and every token transfer
// need 1 yoctoNEAR, which a function-call key cannot attach, and they are not in the key's method list.
//
// Expiry is enforced by this app only (NEAR keys have no expiry on chain); revoking deletes the key on chain.

import { Amount, generateKey, type Near } from "near-kit";
import { parseUnits } from "../amounts";

/** The only arena methods a session key may call. */
export const SESSION_METHODS = ["deposit_from_balance", "claim", "withdraw_initial_deposit"] as const;

/** Methods that move funds out of the arena; they must never be part of a session key. */
export const FORBIDDEN_SESSION_METHODS = ["withdraw_liquid", "ft_transfer", "ft_transfer_call", "fund_balance"] as const;

export const DEPOSIT_METHOD = "deposit_from_balance";

/** Throws when a method list contains anything outside the allowed set. */
export function assertScopedMethods(methods: readonly string[]): void {
  for (const m of methods) {
    if ((FORBIDDEN_SESSION_METHODS as readonly string[]).includes(m)) throw new Error(`${m} must never be granted to a session key`);
    if (!(SESSION_METHODS as readonly string[]).includes(m)) throw new Error(`${m} is not an allowed session method`);
  }
  if (methods.length === 0) throw new Error("A session key needs at least one method");
}

const YOCTO_PER_NEAR = 10n ** 24n;
/** Gas price used to estimate what a call takes from the key's allowance: 1e8 yoctoNEAR per gas unit. */
const GAS_PRICE_YOCTO = 100_000_000n;
const GAS_PER_TGAS = 10n ** 12n;

/** Worst-case allowance cost of a call: its full prepaid gas at the reference gas price. Unparseable gas counts as 300 Tgas. */
export function estimateGasCostYocto(gas: string): bigint {
  const m = /^(\d+)\s*Tgas$/.exec(gas.trim());
  const tgas = m ? BigInt(m[1]!) : 300n;
  return tgas * GAS_PER_TGAS * GAS_PRICE_YOCTO;
}

export interface SessionPolicy {
  accountId: string;
  /** The only contract the key may call. */
  arenaId: string;
  methods: readonly string[];
  expiresAtMs: number;
  /** Gas allowance of the access key, in yoctoNEAR. */
  gasAllowanceYocto: bigint;
  /** Client-side estimate of the allowance already used. */
  gasUsedYocto: bigint;
}

export interface SignableTx {
  receiverId: string;
  method: string;
  /** Attached deposit in yoctoNEAR. */
  deposit: string;
  /** Prepaid gas such as "200 Tgas". */
  gas?: string;
}

export type SessionCheck = { ok: true } | { ok: false; reason: string };

/** Decides whether the session key may sign this transaction. Anything else must go to the wallet. */
export function canSessionSign(policy: SessionPolicy | null, tx: SignableTx, nowMs: number): SessionCheck {
  if (!policy) return { ok: false, reason: "No session key" };
  if (nowMs >= policy.expiresAtMs) return { ok: false, reason: "The session key has expired" };
  if (tx.receiverId !== policy.arenaId) {
    return { ok: false, reason: `The session key is scoped to ${policy.arenaId}; ${tx.receiverId} needs the wallet` };
  }
  if (!policy.methods.includes(tx.method)) return { ok: false, reason: `${tx.method} is outside the session scope` };
  if (tx.deposit !== "0") return { ok: false, reason: "Function-call keys cannot attach a deposit" };
  const cost = estimateGasCostYocto(tx.gas ?? "300 Tgas");
  if (policy.gasUsedYocto + cost > policy.gasAllowanceYocto) return { ok: false, reason: "The session key is out of gas allowance" };
  return { ok: true };
}

export function remainingAllowanceYocto(policy: SessionPolicy): bigint {
  const left = policy.gasAllowanceYocto - policy.gasUsedYocto;
  return left > 0n ? left : 0n;
}

/** Policy after a call was signed by the key: the estimated gas cost is charged to the allowance. */
export function recordSessionUse(policy: SessionPolicy, tx: SignableTx): SessionPolicy {
  return { ...policy, gasUsedYocto: policy.gasUsedYocto + estimateGasCostYocto(tx.gas ?? "300 Tgas") };
}

/** True when the key could sign a balance deposit right now. */
export function canKeyDeposit(session: StoredSession | null, arenaId: string, nowMs: number): boolean {
  if (!session) return false;
  return canSessionSign(session.policy, { receiverId: arenaId, method: DEPOSIT_METHOD, deposit: "0", gas: "200 Tgas" }, nowMs).ok;
}

/** Errors the network gives when a key cannot sign a call (before it runs), so a wallet approval can take over. */
export function isKeyRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /allowance|AccessKey|access key|MethodNameMismatch|ReceiverMismatch|DepositWithFunctionCall|RequiresFullAccess/i.test(message);
}

export function createSessionPolicy(input: {
  accountId: string;
  arenaId: string;
  nowMs: number;
  ttlMs: number;
  /** Gas allowance in NEAR, e.g. "0.25". */
  gasAllowanceNear?: string;
}): SessionPolicy {
  const near = parseUnits(input.gasAllowanceNear ?? "0.25", 24);
  if (near === null || near <= 0n) throw new Error("Invalid gas allowance");
  assertScopedMethods(SESSION_METHODS);
  return {
    accountId: input.accountId,
    arenaId: input.arenaId,
    methods: SESSION_METHODS,
    expiresAtMs: input.nowMs + input.ttlMs,
    gasAllowanceYocto: near,
    gasUsedYocto: 0n,
  };
}

export function formatNear(yocto: bigint, fraction = 3): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = (yocto % YOCTO_PER_NEAR).toString().padStart(24, "0").slice(0, fraction).replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}

export interface StoredSession {
  policy: SessionPolicy;
  /** Private key. Kept in this tab's sessionStorage only and never sent anywhere. */
  secretKey: string;
  publicKey: string;
}

interface WireSession {
  policy: Omit<SessionPolicy, "gasAllowanceYocto" | "gasUsedYocto" | "methods"> & {
    gasAllowanceYocto: string;
    gasUsedYocto: string;
    methods: string[];
  };
  secretKey: string;
  publicKey: string;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Persists a session in the given store (the app passes `sessionStorage`, so it dies with the tab).
 * `load` returns an expired session too, so the user can still revoke it on chain; signing checks expiry.
 */
export function createSessionStore(store: KeyValueStore, keyName = "valtrum:session-key") {
  return {
    load(accountId: string): StoredSession | null {
      const raw = store.getItem(keyName);
      if (!raw) return null;
      try {
        const w = JSON.parse(raw) as WireSession;
        if (w.policy.accountId !== accountId) return null;
        return {
          secretKey: w.secretKey,
          publicKey: w.publicKey,
          policy: { ...w.policy, gasAllowanceYocto: BigInt(w.policy.gasAllowanceYocto), gasUsedYocto: BigInt(w.policy.gasUsedYocto) },
        };
      } catch {
        return null;
      }
    },
    save(s: StoredSession): void {
      const wire: WireSession = {
        secretKey: s.secretKey,
        publicKey: s.publicKey,
        policy: {
          ...s.policy,
          methods: [...s.policy.methods],
          gasAllowanceYocto: s.policy.gasAllowanceYocto.toString(),
          gasUsedYocto: s.policy.gasUsedYocto.toString(),
        },
      };
      store.setItem(keyName, JSON.stringify(wire));
    },
    clear(): void {
      store.removeItem(keyName);
    },
  };
}

/** Generate a key pair and the wallet-signed transaction that registers it. Requires one wallet approval. */
export async function registerSessionKey(wallet: Near, policy: SessionPolicy): Promise<StoredSession> {
  assertScopedMethods(policy.methods);
  const pair = generateKey();
  const publicKey = pair.publicKey.toString();
  await wallet
    .transaction(policy.accountId)
    .addKey(publicKey, {
      type: "functionCall",
      receiverId: policy.arenaId,
      methodNames: [...policy.methods],
      allowance: Amount.yocto(policy.gasAllowanceYocto),
    })
    .send();
  return { policy, secretKey: pair.secretKey, publicKey };
}

/** Deletes the key on chain (one wallet approval). */
export async function deleteSessionKey(wallet: Near, session: StoredSession): Promise<void> {
  await wallet.transaction(session.policy.accountId).deleteKey(session.policy.accountId, session.publicKey).send();
}
