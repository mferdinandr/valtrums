"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { NearProvider, useNearWallet } from "near-connect-hooks";
import { config, configProblems } from "@/lib/config";
import type { Namespace } from "@/lib/arena-read/application";
import type { WalletLike } from "@/lib/arena-read/action-session";

export interface WalletState {
  /** Connected account id, or null when signed out. */
  accountId: string | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);
const ApplicationContext = createContext<Namespace | null>(null);
/** The arena deployment every read is bound to. Always set inside <Providers>. */
export const useApplicationDeployment = () => useContext(ApplicationContext);

/** Reaches the connected wallet for signing. */
const ActionWalletContext = createContext<(() => Promise<WalletLike>) | null>(null);
export const useActionWallet = () => useContext(ActionWalletContext);

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <Providers>");
  return ctx;
}

/** The single screen shown when required configuration is missing. There is no fallback application. */
export function ConfigError({ missing }: { missing: string[] }) {
  return (
    <main role="alert" className="mx-auto max-w-xl space-y-3 p-8">
      <h1 className="text-xl">Valtrum is not configured</h1>
      <p>Set these environment variables in <code>web/.env.local</code> and restart the dev server:</p>
      <ul className="list-disc pl-5">{missing.map((m) => <li key={m}><code>{m}</code></li>)}</ul>
    </main>
  );
}

/**
 * The connected account and a way to reach the wallet for signing. The wallet only signs messages and
 * transactions the user reviewed; no key lives in this bundle.
 */
function WalletBridge({ namespace, children }: { namespace: Namespace; children: ReactNode }) {
  const { signedAccountId, loading, signIn, signOut, connector } = useNearWallet();
  const wallet = useMemo<WalletState>(
    () => ({ accountId: signedAccountId || null, loading, signIn, signOut }),
    [signedAccountId, loading, signIn, signOut],
  );
  const getWallet = useCallback(async () => (await connector.getConnectedWallet()).wallet as unknown as WalletLike, [connector]);
  return (
    <ApplicationContext.Provider value={namespace}>
      <WalletContext.Provider value={wallet}>
        <ActionWalletContext.Provider value={getWallet}>{children}</ActionWalletContext.Provider>
      </WalletContext.Provider>
    </ApplicationContext.Provider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const missing = configProblems();
  if (missing.length > 0) return <ConfigError missing={missing} />;
  const namespace: Namespace = {
    deploymentId: config.deployment,
    network: `near-${config.network}`,
    arenaContract: config.arenaContractId,
    protocol: "lifecycle-v2",
  };
  return (
    <NearProvider config={{ network: config.network }}>
      <WalletBridge namespace={namespace}>{children}</WalletBridge>
    </NearProvider>
  );
}
