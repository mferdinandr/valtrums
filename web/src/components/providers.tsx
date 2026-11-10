"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { NearProvider, useNearWallet } from "near-connect-hooks";
import { config } from "@/lib/config";
import { createMockArenaApi, MOCK_ACCOUNT } from "@/lib/arena/mock";
import { createNearArenaApi } from "@/lib/arena/near";
import type { ArenaApi } from "@/lib/arena/types";
import { createMockEnv, createNearEnv, type TerminalEnv } from "@/lib/terminal/env";
import type { Namespace } from "@/lib/arena-read/application";

export interface WalletState {
  /** Connected account id, or null when signed out. */
  accountId: string | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);
const ArenaContext = createContext<ArenaApi | null>(null);
const TerminalEnvContext = createContext<TerminalEnv | null>(null);
const ApplicationContext = createContext<Namespace | null>(null);
export const useApplicationDeployment = () => useContext(ApplicationContext);

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

export function useTerminalEnv(): TerminalEnv {
  const ctx = useContext(TerminalEnvContext);
  if (!ctx) throw new Error("useTerminalEnv must be used inside <Providers>");
  return ctx;
}

const MOCK_KEY = "valtrum:demo-account";

/** Demo mode: a fake wallet so the whole UI is usable without a deployed contract. */
function MockProviders({ children }: { children: ReactNode }) {
  const api = useMemo(() => createMockArenaApi({ latencyMs: 150 }), []);
  const env = useMemo(() => createMockEnv(api), [api]);
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
      <ArenaContext.Provider value={api}>
        <TerminalEnvContext.Provider value={env}>{children}</TerminalEnvContext.Provider>
      </ArenaContext.Provider>
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

  const env = useMemo(
    () =>
      createNearEnv({
        api,
        arenaId: config.arenaContractId,
        network: config.network,
        rpcUrl: config.rpcUrl,
        connector,
        fundingMode: config.fundingRouter,
      }),
    [api, connector],
  );

  const wallet = useMemo<WalletState>(
    () => ({ accountId: signedAccountId || null, loading, signIn, signOut }),
    [signedAccountId, loading, signIn, signOut],
  );

  return (
    <WalletContext.Provider value={wallet}>
      <ArenaContext.Provider value={api}>
        <TerminalEnvContext.Provider value={env}>{children}</TerminalEnvContext.Provider>
      </ArenaContext.Provider>
    </WalletContext.Provider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  if (config.applicationDeployment) {
    const protocol = config.applicationProtocol;
    if (protocol !== "legacy-v1" && protocol !== "lifecycle-v2") return <p role="alert">Unsupported arena read protocol.</p>;
    const namespace: Namespace = { deploymentId: config.applicationDeployment, network: `near-${config.network}`,
      arenaContract: config.arenaContractId, protocol };
    const unavailable = async () => { throw new Error("Wallet actions are unavailable in application read mode"); };
    return <ApplicationContext.Provider value={namespace}>
      <WalletContext.Provider value={{ accountId: null, loading: false, signIn: unavailable, signOut: unavailable }}>
        {children}
      </WalletContext.Provider>
    </ApplicationContext.Provider>;
  }
  if (config.mock) return <MockProviders>{children}</MockProviders>;
  return (
    <NearProvider config={{ network: config.network }}>
      <NearBridge>{children}</NearBridge>
    </NearProvider>
  );
}
