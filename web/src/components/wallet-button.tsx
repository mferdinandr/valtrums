"use client";

import { useEffect, useRef, useState } from "react";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import gsap from "gsap";
import { Button } from "@/components/ui/button";
import { TokenIcon } from "@/components/token-icon";
import { useWallet } from "@/components/providers";
import { useAction } from "@/hooks/use-action";
import { useBalances } from "@/hooks/use-balances";
import { formatUnits } from "@/lib/amounts";
import { NEAR_DECIMALS, TOKEN_DECIMALS } from "@/lib/arena-read/balances";

function shorten(id: string): string {
  return id.length > 22 ? `${id.slice(0, 10)}...${id.slice(-8)}` : id;
}

/** The account chip; clicking it lists what the account holds. Reads only, nothing here signs. */
function BalanceMenu({ accountId }: { accountId: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { balances, error, loading, refresh, configured } = useBalances();
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !panel.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = panel.current;
    const ctx = gsap.context(() => {
      gsap.fromTo(el, { autoAlpha: 0, y: -8, scale: 0.97, transformOrigin: "top right" }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.22, ease: "power2.out" });
      gsap.from(el.querySelectorAll("li"), { autoAlpha: 0, x: 8, duration: 0.25, stagger: 0.04, delay: 0.08, ease: "power2.out" });
    }, el);
    return () => ctx.revert();
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => { setOpen((v) => !v); if (!open) void refresh(); }}
        className="max-w-[110px] sm:max-w-[150px] truncate rounded-xl border border-neon-green/30 bg-neon-green/5 px-3 py-3 font-pixel text-xs text-neon-green"
        title={accountId}
      >
        {shorten(accountId)} ▾
      </button>
      {open && (
        <div ref={panel} role="region" aria-label="My balance" className="absolute right-0 z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] space-y-2 rounded-xl border border-edge bg-void p-3 text-sm text-[#354358] shadow-xl">
          <p className="font-pixel text-xs text-mute">My balance</p>
          <p className="break-all text-xs text-mute">{accountId}</p>
          {error && <p role="alert" className="text-xs text-neon-red">Could not read balances. {error}</p>}
          {!balances && !error && loading && (
            <SkeletonGroup label="Reading balances…" className="space-y-2">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} style={{ height: 20 }} />)}
            </SkeletonGroup>
          )}
          {!balances && !error && !loading && <p role="status" className="text-xs text-mute">No balances yet.</p>}
          {balances && (
            <ul className="space-y-1.5">
              <li className="flex items-center justify-between gap-2">
                <span>NEAR</span>
                <span>{formatUnits(BigInt(balances.near), NEAR_DECIMALS, 3)}</span>
              </li>
              {balances.tokens.map((t) => (
                <li key={t.token} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2"><TokenIcon symbol={t.symbol} size={20} />{t.symbol}</span>
                  <span>{formatUnits(BigInt(t.balance), TOKEN_DECIMALS, 2)}</span>
                </li>
              ))}
            </ul>
          )}
          {!configured && <p className="text-xs text-mute">Token balances need <code>NEXT_PUBLIC_FAUCET_CONTRACT_ID</code>.</p>}
        </div>
      )}
    </div>
  );
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
      <BalanceMenu accountId={accountId} />
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
