"use client";

import { Button } from "@/components/ui/button";
import { useWallet } from "@/components/providers";
import { useAction } from "@/hooks/use-action";

function shorten(id: string): string {
  return id.length > 22 ? `${id.slice(0, 10)}...${id.slice(-8)}` : id;
}

export function WalletButton() {
  const { accountId, loading, signIn, signOut } = useWallet();
  const action = useAction();
  if (loading) {
    return (
      <Button variant="ghost" size="sm" disabled aria-label="Loading wallet">
        Loading wallet…
      </Button>
    );
  }
  if (!accountId) {
    return (
      <div className="flex max-w-xs flex-col items-end gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={action.busy}
          onClick={() => void action.run(signIn)}
        >
          {action.busy ? "Connecting…" : "Connect wallet"}
        </Button>
        {action.error && (
          <p role="alert" className="text-right text-xs text-neon-red">
            Wallet connection was not completed. Please try again.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="flex max-w-xs flex-wrap items-center justify-end gap-2">
      <span
        className="max-w-[110px] sm:max-w-[150px] truncate rounded-xl border border-neon-green/30 bg-neon-green/5 px-3 py-3 font-pixel text-[11px] text-neon-green"
        title={accountId}
      >
        {shorten(accountId)}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={action.busy}
        onClick={() => void action.run(signOut)}
      >
        {action.busy ? "Disconnecting…" : "Disconnect"}
      </Button>
      {action.error && (
        <p role="alert" className="w-full text-right text-xs text-neon-red">
          Could not disconnect. Please try again.
        </p>
      )}
    </div>
  );
}
