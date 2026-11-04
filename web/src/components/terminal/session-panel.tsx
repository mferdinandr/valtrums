"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { useTerminalEnv, useWallet } from "@/components/providers";
import { useAction } from "@/hooks/use-action";
import {
  createSessionPolicy,
  formatNear,
  remainingAllowanceYocto,
  SESSION_METHODS,
  type StoredSession,
} from "@/lib/terminal/session-key";

const TTL_OPTIONS = [
  { label: "1 hour", ms: 3_600_000 },
  { label: "24 hours", ms: 86_400_000 },
] as const;
const ALLOWANCE_OPTIONS = ["0.1", "0.25", "0.5"] as const;

const selectClass = "ml-2 border-2 border-edge bg-black/50 px-2 py-1 text-xl text-ink";

/** Create, inspect and revoke the scoped function-call access key. States its real exposure up front. */
export function SessionPanel() {
  const { accountId } = useWallet();
  const env = useTerminalEnv();
  const action = useAction();
  const [ttl, setTtl] = useState<number>(TTL_OPTIONS[0].ms);
  const [allowance, setAllowance] = useState<string>(ALLOWANCE_OPTIONS[1]);
  const [session, setSession] = useState<StoredSession | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  if (accountId && loadedFor !== accountId) {
    setLoadedFor(accountId);
    setSession(env.session.get(accountId));
  }
  if (!accountId) return null;

  const create = async () => {
    const policy = createSessionPolicy({ accountId, arenaId: env.chain.arenaId, nowMs: Date.now(), ttlMs: ttl, gasAllowanceNear: allowance });
    return action.run(async () => setSession(await env.session.create(policy)));
  };

  const expired = session !== null && Date.now() >= session.policy.expiresAtMs;
  const left = session ? remainingAllowanceYocto(session.policy) : 0n;

  return (
    <Card className="space-y-3">
      <CardTitle className="mb-0">Session key (optional)</CardTitle>
      <p className="text-lg text-mute">
        A session key is a NEAR access key limited to the arena contract ({env.chain.arenaId}) and the methods {SESSION_METHODS.join(", ")}. With a valid
        key, deposits paid from your arena balance run with no wallet prompt. Funding the balance still needs your wallet once.
      </p>
      <p className="text-lg text-neon-amber">
        What a leaked key can do: spend your funded arena balance (and unexpired credit) on deposits into open battles, and use up its gas allowance. It
        cannot withdraw anything: withdraw_liquid and every token transfer are outside its scope and need your wallet. Keep the balance small.
      </p>
      <p className="text-base text-mute">
        The private key is generated in this browser and kept in this tab&apos;s sessionStorage only. It is never sent to any server and disappears when the
        tab closes. The expiry is enforced by this app; the key stays on chain until you revoke it.
      </p>
      {session ? (
        <div className="space-y-2 text-xl">
          <p role="status" className={expired || left === 0n ? "text-neon-red" : "text-neon-green"}>
            {expired ? "Expired" : left === 0n ? "Out of allowance" : "Active"}: until {new Date(session.policy.expiresAtMs).toLocaleString()}. About{" "}
            {formatNear(left)} NEAR of gas allowance left (estimate). {expired || left === 0n ? "Deposits ask your wallet instead." : ""}
          </p>
          <p className="break-all text-base text-mute">Public key {session.publicKey}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="pink" size="sm" disabled={action.busy} onClick={() => void action.run(async () => {
              await env.session.revoke(accountId);
              setSession(null);
            })}>
              {action.busy ? "Waiting for wallet..." : "Revoke key"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                env.session.forget();
                setSession(null);
              }}
            >
              Forget on this device
            </Button>
          </div>
          <p className="text-base text-mute">
            Revoke deletes the key on chain (one wallet approval). Forget only removes the secret from this browser; the on-chain key then stays unused but still exists.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-lg text-mute">
            Expires in
            <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))} className={selectClass}>
              {TTL_OPTIONS.map((o) => (
                <option key={o.ms} value={o.ms}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-lg text-mute">
            Gas allowance
            <select value={allowance} onChange={(e) => setAllowance(e.target.value)} className={selectClass}>
              {ALLOWANCE_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o} NEAR
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
