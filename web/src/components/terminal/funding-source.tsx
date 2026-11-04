"use client";

import { Button } from "@/components/ui/button";
import { FundBalance } from "@/components/fund-balance";
import { useTerminalEnv, useWallet } from "@/components/providers";
import { useAsync } from "@/hooks/use-async";
import { formatUsdc } from "@/lib/amounts";
import { canKeyDeposit } from "@/lib/terminal/session-key";
import type { DepositPlan } from "@/lib/terminal/plan";

/** Lets the user choose wallet or arena balance for the deposit and fund the balance when it is short. */
export function FundingSource({
  plan,
  onSelect,
}: {
  plan: DepositPlan;
  onSelect: (source: "wallet" | "balance") => void;
}) {
  const env = useTerminalEnv();
  const { accountId } = useWallet();
  const wallet = useAsync(() => (accountId ? env.chain.usdcBalance(accountId) : Promise.resolve(0n)), [env, accountId, plan.balanceAvailable]);

  // Bridged plans always pay through the wallet path.
  if (plan.bridgeLegs.length > 0) return null;

  const needed = plan.totalUnits - plan.creditUnits;
  const short = plan.balanceAvailable < needed ? needed - plan.balanceAvailable : 0n;
  const session = accountId && canKeyDeposit(env.session.get(accountId), env.chain.arenaId, Date.now());

  return (
    <div className="space-y-2 border-2 border-edge p-2">
      <p className="font-pixel text-[9px] uppercase text-mute">Pay from</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={plan.payFromBalance ? "ghost" : "cyan"} aria-pressed={!plan.payFromBalance} onClick={() => onSelect("wallet")}>
          Wallet
        </Button>
        <Button size="sm" variant={plan.payFromBalance ? "cyan" : "ghost"} aria-pressed={plan.payFromBalance} onClick={() => onSelect("balance")}>
          Arena balance
        </Button>
      </div>
      <p className="text-lg text-mute">
        Arena balance: {formatUsdc(plan.balanceAvailable)}. Credit is spent first, so this deposit takes {formatUsdc(needed)} from the balance.
        {session ? " A session key is active, so a balance deposit needs no wallet prompt." : " Create a session key to skip the wallet prompt on balance deposits."}
      </p>
      {short > 0n && (
        <div className="space-y-2">
          <p className="text-lg text-neon-amber">The balance is short by {formatUsdc(short)}. Fund it to pay from the balance.</p>
          <FundBalance
            embedded
            walletUsdc={wallet.data ?? 0n}
            balance={plan.balanceAvailable}
            suggested={short}
            onFunded={() => onSelect("balance")}
          />
        </div>
      )}
    </div>
  );
}
