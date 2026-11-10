import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Near } from "near-kit";
import { ReadSessions } from "../mcp/session.js";
import { loadFaucetConfig } from "./config.js";
import { startFaucetServer } from "./http.js";
import { FaucetLedger } from "./ledger.js";
import { FaucetService, type FaucetChain } from "./service.js";

/**
 * `node dist/faucet/cli.js` serves the testnet faucet. Dry run unless FAUCET_LIVE=1. It holds only the faucet
 * account's own key; the read API keeps holding no key. Testnet only.
 */
const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const v = env[name]?.trim();
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
};

/** The faucet's key from `FAUCET_PRIVATE_KEY`, or the file named by `FAUCET_PRIVATE_KEY_FILE`. Never logged. */
function faucetKey(env: NodeJS.ProcessEnv): string {
  const direct = env.FAUCET_PRIVATE_KEY?.trim();
  const file = env.FAUCET_PRIVATE_KEY_FILE?.trim();
  if (direct && file) throw new Error("set only one of FAUCET_PRIVATE_KEY and FAUCET_PRIVATE_KEY_FILE");
  const key = direct ?? (file ? readFileSync(file, "utf8").trim() : "");
  if (!key) throw new Error("missing faucet key: set FAUCET_PRIVATE_KEY or FAUCET_PRIVATE_KEY_FILE");
  if (!key.startsWith("ed25519:")) throw new Error("the faucet key must be an ed25519:... key");
  return key;
}

export function nearChain(near: Near, faucetAccount: string): FaucetChain {
  return {
    balanceOf: async (token, account) => BigInt(String(await near.view<string>(token, "ft_balance_of", { account_id: account }))),
    isRegistered: async (token, account) => (await near.view<unknown>(token, "storage_balance_of", { account_id: account })) !== null,
    storageMin: async (token) => {
      const bounds = await near.view<{ min: string }>(token, "storage_balance_bounds", {});
      if (!bounds) throw new Error("storage bounds are unavailable");
      return BigInt(String(bounds.min));
    },
    register: async (token, account, deposit) => {
      await near.call(token, "storage_deposit", { account_id: account, registration_only: true }, { gas: "30 Tgas" as never, attachedDeposit: deposit as never, signerId: faucetAccount });
    },
    transfer: async (token, receiver, amount) => {
      const out = (await near.call(token, "ft_transfer", { receiver_id: receiver, amount: amount.toString() }, { gas: "30 Tgas" as never, attachedDeposit: 1n as never, signerId: faucetAccount })) as {
        transaction?: { hash?: string };
        transaction_outcome?: { id?: string };
      };
      const hash = out.transaction?.hash ?? out.transaction_outcome?.id;
      if (!hash) throw new Error("the transaction hash is missing");
      return hash;
    },
  };
}

export async function runCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if ((env.NEAR_NETWORK?.trim() || "testnet") !== "testnet") throw new Error("the faucet runs on testnet only");
  const cfg = loadFaucetConfig(env);
  const live = env.FAUCET_LIVE?.trim() === "1";
  const rpcUrl = env.NEAR_RPC_URL?.trim() || "https://rpc.testnet.near.org";
  const near = new Near({ network: "testnet", rpcUrl, ...(live ? { privateKey: faucetKey(env) as `ed25519:${string}`, defaultSignerId: cfg.account } : {}) });
  const sessions = new ReadSessions({
    secret: new Uint8Array(Buffer.from(required(env, "READ_SESSION_SECRET"), "hex")),
    recipient: required(env, "READ_SESSION_RECIPIENT"),
    // This process only checks tokens the read API issued; it never opens a session itself.
    verify: async () => false,
  });
  const ledger = new FaucetLedger(env.FAUCET_LEDGER_PATH?.trim() || "./.data/faucet-ledger.json");
  const faucet = new FaucetService(cfg, nearChain(near, cfg.account), ledger, { live });
  const port = Number(env.FAUCET_PORT ?? 8792);
  const host = env.FAUCET_HOST?.trim() || "127.0.0.1";
  startFaucetServer(port, host, { faucet, accountOf: (t) => sessions.accountOf(t) });
  console.log(JSON.stringify({ event: "faucet_listening", host, port, live, account: cfg.account, tokens: cfg.tokens.map((t) => t.symbol) }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().catch((err) => {
    console.error(JSON.stringify({ event: "fatal", message: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
