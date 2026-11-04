// Wiring of the terminal's external dependencies for demo (mock) and live (NEAR) mode.

import { Near, fromHotConnect } from "near-kit";
import type { ArenaApi } from "../arena/types";
import { createMockTerminalChain, createNearTerminalChain, type TerminalChain, type TxSender } from "./chain";
import { createMockFundingRouter, type FundingRouter } from "./funding";
import { createNearSender } from "./near-sender";
import { createIntentsFundingRouter } from "./oneclick";
import { createSessionStore, registerSessionKey, type SessionPolicy, type StoredSession } from "./session-key";

export interface SessionControls {
  /** Current stored session for the account, or null. */
  get(accountId: string): StoredSession | null;
  /** Registers a new scoped key (one wallet approval). */
  create(policy: SessionPolicy): Promise<StoredSession>;
  revoke(): void;
}

export interface TerminalEnv {
  chain: TerminalChain;
  sender: TxSender;
  funding: FundingRouter;
  session: SessionControls;
}

type HotConnector = Parameters<typeof fromHotConnect>[0];

export function createMockEnv(api: ArenaApi): TerminalEnv {
  const chain = createMockTerminalChain(api);
  const funding = createMockFundingRouter({ onArrived: (account, amount) => chain.credit(account, amount) });
  let session: StoredSession | null = null;
  return {
    chain,
    sender: chain,
    funding,
    session: {
      get: () => session,
      async create(policy) {
        session = { policy, secretKey: "demo-session" };
        return session;
      },
      revoke() {
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
  const store = createSessionStore(typeof window === "undefined" ? memoryStore() : window.localStorage);

  const sender: TxSender = opts.connector
    ? createNearSender({
        network: opts.network,
        rpcUrl: opts.rpcUrl,
        connector: opts.connector,
        getSession: () => {
          return store.load(currentAccount, Date.now());
        },
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
      get: (accountId) => store.load(accountId, Date.now()),
      async create(policy) {
        if (!opts.connector) throw new Error("Connect a wallet first");
        const wallet = new Near({ network: opts.network, rpcUrl: opts.rpcUrl, wallet: fromHotConnect(opts.connector) });
        const s = await registerSessionKey(wallet, policy);
        store.save(s);
        return s;
      },
      revoke: () => store.clear(),
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
