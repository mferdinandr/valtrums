// Session keys: a scoped function-call access key so repeat actions need no wallet prompt.
//
// Limitation (shown in the UI): a NEAR function-call key cannot attach a deposit, and `ft_transfer_call` on a
// NEP-141 token requires exactly 1 yoctoNEAR attached. A deposit therefore always needs the wallet. A session key
// is scoped to the arena contract only and can sign only arena methods that need no attached deposit.
// The USDC spend limit is enforced client-side (a NEAR key allowance is in NEAR gas, not in USDC).

import { Amount, generateKey, type Near } from "near-kit";

/** Arena methods that need no attached deposit. */
export const SESSION_METHODS = ["claim", "withdraw_initial_deposit"] as const;

export interface SessionPolicy {
  accountId: string;
  /** The only contract the key may call. */
  arenaId: string;
  methods: readonly string[];
  expiresAtMs: number;
  /** NEAR gas allowance of the access key, e.g. "0.25". */
  gasAllowanceNear: string;
  /** Client-side USDC spend limit in base units. */
  maxUsdcUnits: bigint;
  spentUsdcUnits: bigint;
}

export interface SignableTx {
  receiverId: string;
  method: string;
  /** Attached deposit in yoctoNEAR. */
  deposit: string;
  /** USDC base units this transaction moves out of the wallet, if any. */
  usdcSpend?: bigint;
}

export type SessionCheck = { ok: true } | { ok: false; reason: string };

export function canSessionSign(policy: SessionPolicy | null, tx: SignableTx, nowMs: number): SessionCheck {
  if (!policy) return { ok: false, reason: "No session key" };
  if (nowMs >= policy.expiresAtMs) return { ok: false, reason: "The session key has expired" };
  if (tx.receiverId !== policy.arenaId) {
    return { ok: false, reason: `The session key is scoped to ${policy.arenaId}; ${tx.receiverId} needs the wallet` };
  }
  if (!policy.methods.includes(tx.method)) return { ok: false, reason: `${tx.method} is outside the session scope` };
  if (tx.deposit !== "0") return { ok: false, reason: "Function-call keys cannot attach a deposit" };
  const spend = tx.usdcSpend ?? 0n;
  if (policy.spentUsdcUnits + spend > policy.maxUsdcUnits) return { ok: false, reason: "The session spending limit would be exceeded" };
  return { ok: true };
}

export function createSessionPolicy(input: {
  accountId: string;
  arenaId: string;
  nowMs: number;
  ttlMs: number;
  maxUsdcUnits: bigint;
  gasAllowanceNear?: string;
}): SessionPolicy {
  return {
    accountId: input.accountId,
    arenaId: input.arenaId,
    methods: SESSION_METHODS,
    expiresAtMs: input.nowMs + input.ttlMs,
    gasAllowanceNear: input.gasAllowanceNear ?? "0.25",
    maxUsdcUnits: input.maxUsdcUnits,
    spentUsdcUnits: 0n,
  };
}

export interface StoredSession {
  policy: SessionPolicy;
  secretKey: string;
}

interface WireSession {
  policy: Omit<SessionPolicy, "maxUsdcUnits" | "spentUsdcUnits" | "methods"> & {
    maxUsdcUnits: string;
    spentUsdcUnits: string;
    methods: string[];
  };
  secretKey: string;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Persists a session in browser storage. The secret only ever authorizes the scope above. */
export function createSessionStore(store: KeyValueStore, keyName = "valtrum:session-key") {
  return {
    load(accountId: string, nowMs: number): StoredSession | null {
      const raw = store.getItem(keyName);
      if (!raw) return null;
      try {
        const w = JSON.parse(raw) as WireSession;
        if (w.policy.accountId !== accountId || nowMs >= w.policy.expiresAtMs) return null;
        return {
          secretKey: w.secretKey,
          policy: { ...w.policy, methods: w.policy.methods, maxUsdcUnits: BigInt(w.policy.maxUsdcUnits), spentUsdcUnits: BigInt(w.policy.spentUsdcUnits) },
        };
      } catch {
        return null;
      }
    },
    save(s: StoredSession): void {
      const wire: WireSession = {
        secretKey: s.secretKey,
        policy: { ...s.policy, methods: [...s.policy.methods], maxUsdcUnits: s.policy.maxUsdcUnits.toString(), spentUsdcUnits: s.policy.spentUsdcUnits.toString() },
      };
      store.setItem(keyName, JSON.stringify(wire));
    },
    clear(): void {
      store.removeItem(keyName);
    },
  };
}

/** Generate a key pair and the wallet-signed transaction that registers it. Requires one wallet approval. */
export async function registerSessionKey(
  wallet: Near,
  policy: SessionPolicy,
): Promise<StoredSession> {
  const pair = generateKey();
  await wallet
    .transaction(policy.accountId)
    .addKey(pair.publicKey.toString(), {
      type: "functionCall",
      receiverId: policy.arenaId,
      methodNames: [...policy.methods],
      allowance: Amount.NEAR(Number(policy.gasAllowanceNear)),
    })
    .send();
  return { policy, secretKey: pair.secretKey };
}
