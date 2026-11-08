// Wiring of the terminal's external dependencies for demo (mock) and live (NEAR) mode.
// FIXTURE: demo mode wires only mocks; nothing it shows is observed on a network.

import { Near, fromHotConnect } from "near-kit";
import type { ArenaApi } from "../arena/types";
import { createMockTerminalChain, createNearTerminalChain, type TerminalChain, type TxSender } from "./chain";
import { createMockFundingRouter, type FundingRouter } from "./funding";
import { createNearSender } from "./near-sender";
import { createIntentsFundingRouter } from "./oneclick";
import { createSessionStore, deleteSessionKey, registerSessionKey, type SessionPolicy, type StoredSession } from "./session-key";

export interface SessionControls {
  /** Current stored session for the account, or null. */
  get(accountId: string): StoredSession | null;
  /** Registers a new scoped key (one wallet approval). */
  create(policy: SessionPolicy): Promise<StoredSession>;
  /** Deletes the key on chain (one wallet approval) and forgets it locally. */
  revoke(accountId: string): Promise<void>;
  /** Forgets the secret in this browser without touching the chain. */
  forget(): void;
}

export interface TerminalEnv {
  chain: TerminalChain;
  sender: TxSender;
  funding: FundingRouter;
  session: SessionControls;
}

type HotConnector = Parameters<typeof fromHotConnect>[0];

export function createMockEnv(api: ArenaApi): TerminalEnv {
  let session: StoredSession | null = null;
  const chain = createMockTerminalChain(api, { getSession: () => session, onSessionUsed: (s) => (session = s) });
  const funding = createMockFundingRouter({ onArrived: (account, amount) => chain.credit(account, amount) });
  return {
    chain,
    sender: chain,
    funding,
    session: {
      get: () => session,
      async create(policy) {
        session = { policy, secretKey: "demo-session", publicKey: "ed25519:demo" };
        return session;
      },
      async revoke() {
        session = null;
      },
      forget() {
        session = null;
      },
    },
  };
}

export interface NearEnvOptions {
  api: ArenaApi;
  arenaId: string;
  network: "testnet" | "mainnet";
  rpcUrl: string;
  connector?: HotConnector;
  fundingMode: "mock" | "intents";
}

export function createNearEnv(opts: NearEnvOptions): TerminalEnv {
  let usdc: Promise<string> | null = null;
  const getUsdcId = () => (usdc ??= opts.api.getConfig().then((c) => c.usdc));
  const chain = createNearTerminalChain({ arenaId: opts.arenaId, getUsdcId, network: opts.network, rpcUrl: opts.rpcUrl });
  // The sender reads the session of whichever account is signing.
  let currentAccount = "";
  // sessionStorage: the private key lives in this tab only, never in a server or in long-term storage.
  const store = createSessionStore(typeof window === "undefined" ? memoryStore() : window.sessionStorage);

  const sender: TxSender = opts.connector
    ? createNearSender({
        network: opts.network,
        rpcUrl: opts.rpcUrl,
        connector: opts.connector,
        getSession: () => {
          return store.load(currentAccount);
        },
        onSessionUsed: (s) => store.save(s),
      })
    : {
        async send() {
          throw new Error("Connect a wallet first");
        },
      };
  const wrapped: TxSender = {
    send(tx, signerId) {
      currentAccount = signerId;
      return sender.send(tx, signerId);
    },
  };

  return {
    chain,
    sender: wrapped,
    funding: opts.fundingMode === "intents" ? createIntentsFundingRouter() : createMockFundingRouter(),
    session: {
      get: (accountId) => store.load(accountId),
      async create(policy) {
        if (!opts.connector) throw new Error("Connect a wallet first");
        const wallet = new Near({ network: opts.network, rpcUrl: opts.rpcUrl, wallet: fromHotConnect(opts.connector) });
        const s = await registerSessionKey(wallet, policy);
        store.save(s);
        return s;
      },
      async revoke(accountId) {
        const s = store.load(accountId);
        if (s) {
          if (!opts.connector) throw new Error("Connect a wallet first");
          const wallet = new Near({ network: opts.network, rpcUrl: opts.rpcUrl, wallet: fromHotConnect(opts.connector) });
          await deleteSessionKey(wallet, s);
        }
        store.clear();
      },
      forget: () => store.clear(),
    },
  };
}

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}
