"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { NearProvider, useNearWallet } from "near-connect-hooks";
import { config } from "@/lib/config";
import { createMockArenaApi, MOCK_ACCOUNT } from "@/lib/arena/mock";
import { createNearArenaApi } from "@/lib/arena/near";
import type { ArenaApi } from "@/lib/arena/types";

export interface WalletState {
  /** Connected account id, or null when signed out. */
  accountId: string | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);
const ArenaContext = createContext<ArenaApi | null>(null);

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <Providers>");
  return ctx;
}

export function useArena(): ArenaApi {
  const ctx = useContext(ArenaContext);
  if (!ctx) throw new Error("useArena must be used inside <Providers>");
  return ctx;
}

const MOCK_KEY = "valtrum:demo-account";

/** Demo mode: a fake wallet so the whole UI is usable without a deployed contract. */
function MockProviders({ children }: { children: ReactNode }) {
  const api = useMemo(() => createMockArenaApi({ latencyMs: 150 }), []);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setAccountId(window.localStorage.getItem(MOCK_KEY));
    setLoading(false);
  }, []);

  const signIn = useCallback(async () => {
    window.localStorage.setItem(MOCK_KEY, MOCK_ACCOUNT);
    setAccountId(MOCK_ACCOUNT);
  }, []);
  const signOut = useCallback(async () => {
    window.localStorage.removeItem(MOCK_KEY);
    setAccountId(null);
  }, []);

  const wallet = useMemo(() => ({ accountId, loading, signIn, signOut }), [accountId, loading, signIn, signOut]);
  return (
    <WalletContext.Provider value={wallet}>
      <ArenaContext.Provider value={api}>{children}</ArenaContext.Provider>
    </WalletContext.Provider>
  );
}

function NearBridge({ children }: { children: ReactNode }) {
  const { signedAccountId, loading, signIn, signOut, connector } = useNearWallet();

  const api = useMemo(
    () =>
      createNearArenaApi({
        contractId: config.arenaContractId,
        network: config.network,
        rpcUrl: config.rpcUrl,
        connector,
      }),
    [connector],
  );

  const wallet = useMemo<WalletState>(
    () => ({ accountId: signedAccountId || null, loading, signIn, signOut }),
    [signedAccountId, loading, signIn, signOut],
  );

  return (
    <WalletContext.Provider value={wallet}>
      <ArenaContext.Provider value={api}>{children}</ArenaContext.Provider>
    </WalletContext.Provider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  if (config.mock) return <MockProviders>{children}</MockProviders>;
  return (
    <NearProvider config={{ network: config.network }}>
      <NearBridge>{children}</NearBridge>
    </NearProvider>
  );
}
