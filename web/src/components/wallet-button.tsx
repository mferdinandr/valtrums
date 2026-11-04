"use client";

import { Button } from "@/components/ui/button";
import { useWallet } from "@/components/providers";

function shorten(id: string): string {
  return id.length > 22 ? `${id.slice(0, 10)}...${id.slice(-8)}` : id;
}

export function WalletButton() {
  const { accountId, loading, signIn, signOut } = useWallet();

  if (loading) {
    return (
      <Button variant="ghost" size="sm" disabled>
        ...
      </Button>
    );
  }
  if (!accountId) {
    return (
      <Button variant="primary" size="sm" onClick={() => void signIn()}>
        Connect wallet
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="border-2 border-neon-green px-2 py-2 font-pixel text-[9px] text-neon-green" title={accountId}>
        {shorten(accountId)}
      </span>
      <Button variant="ghost" size="sm" onClick={() => void signOut()}>
        Exit
      </Button>
    </div>
  );
}
