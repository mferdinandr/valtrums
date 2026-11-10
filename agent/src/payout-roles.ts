import { readFileSync } from "node:fs";
import { Near } from "near-kit";
import type { NearTransport } from "./near-client.js";
import { withViewRetries } from "./rpc-resilience.js";

/**
 * Runtime config shared by the two payout roles that sign NEAR transactions (OpenSpec
 * arena-chain-signatures, issue #150). The relayer (request signatures, broadcast bookkeeping) and the
 * operator (confirm, revert, restore) are separate processes with separate accounts and keys. Neither
 * reads the other's variables, and neither reads the arena agent key: a process that finds the other
 * role's key in its environment refuses to start, so one deployment can never hold both.
 */
export type PayoutRole = "RELAYER" | "OPERATOR";

export interface PayoutRoleConfig {
  role: PayoutRole;
  network: "testnet" | "mainnet";
  rpcUrl: string;
  payoutContractId: string;
  accountId: string;
  /** Secret. Never log or serialize this value. */
  privateKey: string;
  /** Source-chain read RPC (https). May embed a key: never log it. */
  evmRpcUrl: string;
  /** Source chain every payout of this deployment must name. */
  chainId: bigint;
  intervalSecs: number;
}

const OTHER: Record<PayoutRole, PayoutRole> = { RELAYER: "OPERATOR", OPERATOR: "RELAYER" };

function key(role: PayoutRole, name: string): string {
  return `PAYOUT_${role}_${name}`;
}

export function resolveRoleKey(
  role: PayoutRole,
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string {
  const direct = env[key(role, "PRIVATE_KEY")]?.trim();
  const file = env[key(role, "PRIVATE_KEY_FILE")]?.trim();
  if (direct && file) throw new Error(`set only one of ${key(role, "PRIVATE_KEY")} and ${key(role, "PRIVATE_KEY_FILE")}`);
  if (!direct && !file) throw new Error(`missing key: set ${key(role, "PRIVATE_KEY")} or ${key(role, "PRIVATE_KEY_FILE")}`);
  let value = direct;
  if (!value) {
    try {
      value = readFile(file as string).trim();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(`cannot read ${key(role, "PRIVATE_KEY_FILE")}${code ? ` (${code})` : ""}`);
    }
  }
  if (!value) throw new Error(`${key(role, "PRIVATE_KEY_FILE")} is empty`);
  // Do not echo the value: it is a secret.
  if (!value.startsWith("ed25519:")) throw new Error(`${key(role, "PRIVATE_KEY")} must be an ed25519:... key`);
  return value;
}

export function loadPayoutRoleConfig(
  role: PayoutRole,
  env: Record<string, string | undefined> = process.env,
  readFile?: (path: string) => string,
): PayoutRoleConfig {
  // Role separation: the other role's credentials and the arena agent key must not be present.
  for (const name of [key(OTHER[role], "ACCOUNT_ID"), key(OTHER[role], "PRIVATE_KEY"), key(OTHER[role], "PRIVATE_KEY_FILE"), "AGENT_PRIVATE_KEY", "AGENT_PRIVATE_KEY_FILE"]) {
    if (env[name] !== undefined && env[name] !== "") {
      throw new Error(`${name} must not be set in the payout ${role.toLowerCase()} process; remove it`);
    }
  }
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`missing required environment variable ${name}`);
    return v;
  };
  const network = env.NEAR_NETWORK?.trim() || "testnet";
  if (network !== "testnet" && network !== "mainnet") throw new Error('NEAR_NETWORK must be "testnet" or "mainnet"');
  const evmRpcUrl = need("PAYOUT_EVM_RPC_URL");
  if (!/^https:\/\//.test(evmRpcUrl)) throw new Error("PAYOUT_EVM_RPC_URL must be an https URL");
  const chain = need("PAYOUT_CHAIN_ID");
  if (!/^[1-9][0-9]*$/.test(chain)) throw new Error("PAYOUT_CHAIN_ID must be a positive integer");
  const interval = Number(env.PAYOUT_INTERVAL_SECS?.trim() || "30");
  if (!Number.isInteger(interval) || interval < 5) throw new Error("PAYOUT_INTERVAL_SECS must be an integer of at least 5");
  return {
    role,
    network,
    rpcUrl: env.NEAR_RPC_URL?.trim() || `https://rpc.${network}.near.org`,
    payoutContractId: need("PAYOUT_CONTRACT_ID"),
    accountId: need(key(role, "ACCOUNT_ID")),
    privateKey: resolveRoleKey(role, env, readFile),
    evmRpcUrl,
    chainId: BigInt(chain),
    intervalSecs: interval,
  };
}

export function createRoleTransport(cfg: PayoutRoleConfig): NearTransport {
  const near = new Near({
    network: cfg.network,
    rpcUrl: cfg.rpcUrl,
    privateKey: cfg.privateKey as `ed25519:${string}`,
    defaultSignerId: cfg.accountId,
  });
  return withViewRetries({
    view: (contractId, method, args) => near.view(contractId, method, args),
    call: (contractId, method, args, gas, attachedDeposit) =>
      near.call(contractId, method, args, {
        gas: gas as never,
        signerId: cfg.accountId,
        ...(attachedDeposit ? { attachedDeposit: attachedDeposit as never } : {}),
      }),
  });
}
