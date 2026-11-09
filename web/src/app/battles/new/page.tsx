"use client";

import { useState } from "react";
import Link from "next/link";
import { TargetFlow } from "@/components/target-flow";
import { FlowNotice } from "@/components/flow-notice";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { useArena, useWallet } from "@/components/providers";
import { useAction } from "@/hooks/use-action";
import { useAsync } from "@/hooks/use-async";
import { formatUsdc, toBigInt } from "@/lib/amounts";

const DURATIONS = [
  { label: "1 hour", secs: 3600 },
  { label: "6 hours", secs: 6 * 3600 },
  { label: "24 hours", secs: 24 * 3600 },
  { label: "3 days", secs: 3 * 86400 },
];

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const validAccount = (s: string): boolean =>
  s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);

export default function CreateBattlePage() {
  const api = useArena();
  const { accountId, signIn } = useWallet();
  const cfg = useAsync(() => api.getConfig(), [api]);
  const [tokenA, setTokenA] = useState("");
  const [tokenB, setTokenB] = useState("");
  const [secs, setSecs] = useState(24 * 3600);
  const [done, setDone] = useState(false);
  const action = useAction();

  const a = tokenA.trim().toLowerCase();
  const b = tokenB.trim().toLowerCase();
  const problem =
    a && !validAccount(a)
      ? "Token A is not a valid account id."
      : b && !validAccount(b)
        ? "Token B is not a valid account id."
        : a && a === b
          ? "Pick two different coins."
          : null;
  const ready = validAccount(a) && validAccount(b) && !problem;
  const bond = cfg.data ? toBigInt(cfg.data.bond) : null;

  const submit = async () => {
    if (!accountId || !ready) return;
    setDone(false);
    if (
      await action.run(() =>
        api.proposeBattle({
          signerId: accountId,
          tokenA: a,
          tokenB: b,
          durationSecs: secs,
        }),
      )
    ) {
      setDone(true);
      setTokenA("");
      setTokenB("");
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <FlowNotice />
      <TargetFlow page="create" />
      <div><Link href="/arena" className="text-xs text-neon-green">← Back to battles</Link><p className="eyebrow mt-5 text-neon-green">CREATE / CURRENT ARENA</p><h1 className="mt-3 text-3xl">Set up a rivalry.</h1><p className="mt-3 text-sm leading-6 text-mute">Choose two token contracts and a duration. Review the bond before proposing your battle for audit.</p></div>
      <Card>
        <CardTitle>01 / Choose communities and duration</CardTitle>
        <div className="space-y-4">
          <div>
            <Label htmlFor="token-a">Token A (NEP-141 contract id)</Label>
            <Input
              id="token-a"
              placeholder="pepe.tkn.testnet"
              value={tokenA}
              onChange={(e) => setTokenA(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="token-b">Token B (NEP-141 contract id)</Label>
            <Input
              id="token-b"
              placeholder="shib.tkn.testnet"
              value={tokenB}
              onChange={(e) => setTokenB(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="duration">Battle duration</Label>
            <select
              id="duration"
              value={secs}
              onChange={(e) => setSecs(Number(e.target.value))}
              className="w-full border-2 border-edge bg-black/50 px-3 py-2 font-term text-xl text-ink focus:border-neon-cyan focus:outline-none"
            >
              {DURATIONS.map((d) => (
                <option key={d.secs} value={d.secs}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          {problem && (
            <p role="alert" className="text-lg text-neon-red">
              {problem}
            </p>
          )}
        </div>
      </Card>

      <Card className="border-neon-amber">
        <CardTitle className="text-neon-amber">02 / Review proposal bond</CardTitle>
        <p className="text-3xl text-neon-amber">
          {bond === null ? "--" : formatUsdc(bond)}
        </p>
        <p className="mt-2 text-lg text-mute">
          Sent in USDC with the proposal. The agent audits both coins; if the
          battle fails the audit and is voided, the bond is forfeited.
        </p>
      </Card>

      {accountId ? (
        <Button
          size="lg"
          variant="pink"
          onClick={() => void submit()}
          disabled={!ready || action.busy || cfg.data?.paused}
        >
          {action.busy ? "Sending..." : "Propose battle"}
        </Button>
      ) : (
        <Button size="lg" variant="cyan" onClick={() => void signIn()}>
          Connect wallet to propose
        </Button>
      )}
      {cfg.data?.paused && (
        <p className="text-lg text-neon-red">The arena is paused.</p>
      )}
      {action.error && (
        <p role="alert" className="text-lg text-neon-red">
          {action.error}
        </p>
      )}
      {done && (
        <p className="text-xl text-neon-green">
          Proposal sent.{" "}
          <Link href="/arena" className="underline">
            See it in the arena
          </Link>
          .
        </p>
      )}
    </div>
  );
}
