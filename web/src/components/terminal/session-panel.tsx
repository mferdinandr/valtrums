"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { useTerminalEnv, useWallet } from "@/components/providers";
import { useAction } from "@/hooks/use-action";
import { formatUsdc } from "@/lib/amounts";
import { createSessionPolicy, SESSION_METHODS, type StoredSession } from "@/lib/terminal/session-key";

const TTL_OPTIONS = [
  { label: "1 hour", ms: 3_600_000 },
  { label: "24 hours", ms: 86_400_000 },
] as const;
const LIMIT_OPTIONS = [10_000_000n, 50_000_000n, 200_000_000n] as const;

/** Create or revoke a scoped function-call access key. States its limits up front. */
export function SessionPanel() {
  const { accountId } = useWallet();
  const env = useTerminalEnv();
  const action = useAction();
  const [ttl, setTtl] = useState<number>(TTL_OPTIONS[0].ms);
  const [limit, setLimit] = useState<bigint>(LIMIT_OPTIONS[0]);
  const [session, setSession] = useState<StoredSession | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  if (accountId && loadedFor !== accountId) {
    setLoadedFor(accountId);
    setSession(env.session.get(accountId));
  }
  if (!accountId) return null;

  const create = async () => {
    const policy = createSessionPolicy({ accountId, arenaId: env.chain.arenaId, nowMs: Date.now(), ttlMs: ttl, maxUsdcUnits: limit });
    const ok = await action.run(async () => setSession(await env.session.create(policy)));
    return ok;
  };

  return (
    <Card className="space-y-3">
      <CardTitle className="mb-0">Session key (optional)</CardTitle>
      <p className="text-lg text-mute">
        A session key is a NEAR access key limited to the arena contract ({env.chain.arenaId}) and the methods{" "}
        {SESSION_METHODS.join(", ")}. It has a gas allowance and an expiry, and never moves USDC.
      </p>
      <p className="text-lg text-neon-amber">
        Deposits always ask your wallet: NEAR function-call keys cannot attach the 1 yoctoNEAR that a USDC transfer needs, so a session key cannot sign
        them.
      </p>
      {session ? (
        <div className="space-y-2 text-xl">
          <p>
            Active until {new Date(session.policy.expiresAtMs).toLocaleString()}. Gas allowance {session.policy.gasAllowanceNear} NEAR. Spend limit{" "}
            {formatUsdc(session.policy.maxUsdcUnits, 0)} (used {formatUsdc(session.policy.spentUsdcUnits, 2)}).
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              env.session.revoke();
              setSession(null);
            }}
          >
            Forget key
          </Button>
          <p className="text-base text-mute">Forgetting removes the secret from this browser, so the on-chain key can no longer be used.</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-lg text-mute">
            Expires in
            <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))} className="ml-2 border-2 border-edge bg-black/50 px-2 py-1 text-xl text-ink">
              {TTL_OPTIONS.map((o) => (
                <option key={o.ms} value={o.ms}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-lg text-mute">
            Spend limit
            <select value={limit.toString()} onChange={(e) => setLimit(BigInt(e.target.value))} className="ml-2 border-2 border-edge bg-black/50 px-2 py-1 text-xl text-ink">
              {LIMIT_OPTIONS.map((o) => (
                <option key={o.toString()} value={o.toString()}>
                  {formatUsdc(o, 0)}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" disabled={action.busy} onClick={() => void create()}>
            {action.busy ? "Waiting for wallet..." : "Create session key"}
          </Button>
        </div>
      )}
      {action.error && (
        <p role="alert" className="text-lg text-neon-red">
          {action.error}
        </p>
      )}
    </Card>
  );
}
