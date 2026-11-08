import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Near, verifyNep413Signature } from "near-kit";
import { JsonFileReportArchive } from "../audit/report-archive.js";
import { parseDelegateGrants } from "./actions/proposal.js";
import { NearRpcReceiptVerifier } from "./actions/receipt.js";
import { ActionService } from "./actions/service.js";
import { NearActionReadSource } from "./actions/source.js";
import { ActionStore } from "./actions/store.js";
import type { ActionToolDeps } from "./actions/tools.js";
import { startReadServer } from "./http.js";
import { NearArenaReadSource } from "./read-source.js";
import { buildMcpServer } from "./server.js";
import { ReadSessions } from "./session.js";

/**
 * Entry point: `node dist/mcp/cli.js mcp` serves MCP over stdio, `node dist/mcp/cli.js http`
 * serves the read API for the web terminal. The read service builds a NEAR client without any
 * private key, so it cannot sign even if a handler tried.
 *
 * Env: NEAR_NETWORK, NEAR_RPC_URL, ARENA_CONTRACT_ID, PAYOUT_CONTRACT_ID (optional),
 * READ_SESSION_SECRET (hex, >= 32 bytes), READ_SESSION_RECIPIENT, AUDIT_ARCHIVE_PATH (optional),
 * READ_API_HOST (default 127.0.0.1), READ_API_PORT (default 8790). Actions (optional): ACTION_STORE_PATH
 * enables them; PLAYER_POLICY_CONTRACT_ID for grant reservations; ACTION_RECIPIENT (NEP-413
 * recipient, default READ_SESSION_RECIPIENT); PLAYER_AGENT_GRANTS (JSON, delegate -> grants it may
 * propose under; operator configuration, never model output).
 */

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]?.trim();
  if (!v) throw new Error(`${key} is required`);
  return v;
}

export function depsFromEnv(env: NodeJS.ProcessEnv): ActionToolDeps {
  const network = env.NEAR_NETWORK?.trim() || "testnet";
  if (network !== "testnet" && network !== "mainnet") throw new Error('NEAR_NETWORK must be "testnet" or "mainnet"');
  const secretHex = required(env, "READ_SESSION_SECRET");
  if (!/^[0-9a-fA-F]{64,}$/.test(secretHex) || secretHex.length % 2 !== 0) {
    throw new Error("READ_SESSION_SECRET must be at least 32 bytes of hex");
  }
  const near = new Near({ network, ...(env.NEAR_RPC_URL?.trim() ? { rpcUrl: env.NEAR_RPC_URL.trim() } : {}) });
  const arena = new NearArenaReadSource(
    { network: `near-${network}`, kind: "live", name: required(env, "ARENA_CONTRACT_ID") },
    (contractId, method, args) => near.view(contractId, method, args),
    { arena: required(env, "ARENA_CONTRACT_ID"), payout: env.PAYOUT_CONTRACT_ID?.trim() || null },
  );
  const sessions = new ReadSessions({
    secret: new Uint8Array(Buffer.from(secretHex, "hex")),
    recipient: required(env, "READ_SESSION_RECIPIENT"),
    // Our own nonce check runs first (age + replay); near-kit checks the signature and full-access key.
    verify: (signed, params) => verifyNep413Signature(signed, params, { near, nonceValidation: "none" }),
  });
  const archivePath = env.AUDIT_ARCHIVE_PATH?.trim();
  // Actions are enabled only with a durable store; the service never holds a key either.
  const storePath = env.ACTION_STORE_PATH?.trim();
  const actions = storePath
    ? new ActionService({
        source: new NearActionReadSource(
          { network: `near-${network}`, kind: "live", name: required(env, "ARENA_CONTRACT_ID") },
          (contractId, method, args) => near.view(contractId, method, args),
          { arena: required(env, "ARENA_CONTRACT_ID"), policy: env.PLAYER_POLICY_CONTRACT_ID?.trim() || null },
        ),
        ctx: {
          network: `near-${network}`,
          arena: required(env, "ARENA_CONTRACT_ID"),
          payout: env.PAYOUT_CONTRACT_ID?.trim() || null,
          policy: env.PLAYER_POLICY_CONTRACT_ID?.trim() || null,
        },
        store: new ActionStore(storePath),
        recipient: env.ACTION_RECIPIENT?.trim() || required(env, "READ_SESSION_RECIPIENT"),
        verify: (signed, params) => verifyNep413Signature(signed, params, { near, nonceValidation: "none" }),
        receipts: new NearRpcReceiptVerifier(env.NEAR_RPC_URL?.trim() || `https://rpc.${network}.near.org`),
        delegateGrants: parseDelegateGrants(env.PLAYER_AGENT_GRANTS),
      })
    : undefined;
  return {
    arena,
    sessions,
    ...(actions ? { actions } : {}),
    now: Date.now,
    ...(archivePath
      ? { audits: { archive: new JsonFileReportArchive(archivePath), info: { network: `near-${network}`, kind: "recorded" as const, name: "audit-report-archive" } } }
      : {}),
  };
}

export async function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const deps = depsFromEnv(env);
  if (args[0] === "mcp") {
    await buildMcpServer(deps).connect(new StdioServerTransport());
    return;
  }
  if (args[0] === "http") {
    const host = env.READ_API_HOST?.trim() || "127.0.0.1";
    const port = Number(env.READ_API_PORT ?? 8790);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("READ_API_PORT must be a valid port");
    startReadServer(port, host, { ...deps, sessions: deps.sessions });
    console.error(`read API listening on ${host}:${port}`);
    return;
  }
  throw new Error("usage: mcp/cli.js <mcp|http>");
}

const invokedDirectly = (() => {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
