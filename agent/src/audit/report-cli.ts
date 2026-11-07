import { argv, env as processEnv } from "node:process";
import { fileURLToPath } from "node:url";
import { evaluateCommunity, type AuditInput } from "./decision.js";
import type { RawGoPlusResponse } from "./goplus.js";
import { VALUATION_SOURCE, type LpEvidence } from "./liquidity.js";
import { buildAuditPolicy } from "./policy.js";
import {
  JsonFileReportArchive,
  type ArchiveObservationInput,
  type ReportArchive,
} from "./report-archive.js";
import { queryObservations, type ReportQuery } from "./report-query.js";
import { parseReportPort, startReportServer } from "./report-server.js";
import { buildAuditReport, formatAuditReport } from "./report.js";

/**
 * Explicit, runnable read-only entry point for the audit report archive, plus a clearly labelled
 * development seeder. There is no public write endpoint: `seed-demo` writes synthetic fixtures (not
 * live GoPlus/LP data) through the same internal typed sink the lifecycle pass uses. The server is
 * passive and binds loopback by default.
 */

export const DEFAULT_ARCHIVE_DIR = "./.agent-state/audit-reports";
const archivePath = (dir: string): string => `${dir}/archive.json`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const consoleIo: CliIo = { out: (l) => console.log(l), err: (l) => console.error(l) };

interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string>;
  bools: Set<string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  const BOOL_FLAGS = new Set(["text"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (BOOL_FLAGS.has(name)) {
        bools.add(name);
      } else {
        const next = args[i + 1];
        if (next === undefined) throw new Error(`flag --${name} needs a value`);
        flags.set(name, next);
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { command: positionals[0], positionals: positionals.slice(1), flags, bools };
}

function resolveDir(parsed: ParsedArgs, env: Record<string, string | undefined>): string {
  return parsed.flags.get("dir") ?? env.AUDIT_REPORT_DIR?.trim() ?? DEFAULT_ARCHIVE_DIR;
}

function queryFromFlags(flags: Map<string, string>): ReportQuery {
  const q: ReportQuery = {};
  const copy = (k: keyof ReportQuery) => {
    const v = flags.get(k);
    if (v !== undefined) (q as Record<string, unknown>)[k] = v;
  };
  for (const k of ["arena", "network", "chainId", "token", "referenceToken", "result", "freshness", "policyVersion", "policyHash", "battleId", "community", "pageSize", "cursor"] as const) {
    copy(k);
  }
  return q;
}

// --- Development-only fixtures: synthetic GoPlus-shaped evidence, never live provider output. ---

const CLEAN_ENTRY: Record<string, string> = {
  is_honeypot: "0",
  cannot_sell_all: "0",
  cannot_buy: "0",
  buy_tax: "0",
  sell_tax: "0",
  transfer_tax: "0",
  slippage_modifiable: "0",
  personal_slippage_modifiable: "0",
  transfer_pausable: "0",
  owner_change_balance: "0",
  is_blacklisted: "0",
  is_whitelisted: "0",
  is_mintable: "0",
  is_open_source: "1",
  is_proxy: "0",
  owner_address: "",
  hidden_owner: "0",
  can_take_back_ownership: "0",
  is_in_dex: "1",
};

// Fixed so the demo is deterministic: stable evidence hashes and idempotent re-seeding. Freshness is
// still computed live at read time against the server clock, so a served demo pass reads as expired.
const DEMO_TIME = "2026-11-08T00:00:00.000Z";

function demoGoplus(chainId: string, token: string, overrides: Record<string, string> = {}): RawGoPlusResponse {
  const entry = { ...CLEAN_ENTRY, ...overrides };
  const body = { code: 1, message: "OK", result: { [token]: entry } };
  return {
    query: { chainId, token },
    providerVersion: "token_security/v1",
    queriedAt: DEMO_TIME,
    httpStatus: 200,
    rawText: JSON.stringify(body),
    body,
  };
}

function demoLp(chainId: string, token: string, usd: string): LpEvidence {
  return {
    chainId,
    token,
    pools: [
      {
        chainId,
        poolId: "0xpool-demo",
        token,
        quoteAsset: "WETH",
        kind: "constant_product",
        headlineUsd: usd,
        valuationSource: VALUATION_SOURCE,
        observedAt: DEMO_TIME,
        observedBlock: "100",
      },
    ],
  };
}

/** Three labelled development observations: a direct pass, a reference-token pass and a reject. */
export function buildDemoObservations(): ArchiveObservationInput[] {
  const policy = buildAuditPolicy();
  const now = new Date(DEMO_TIME);
  const mk = (input: AuditInput): ArchiveObservationInput["report"] => buildAuditReport(evaluateCommunity(input));

  const directToken = "0x00000000000000000000000000000000000000a1";
  const direct = mk({
    asset: { chainId: "4663", token: directToken, representation: "demo-direct.testnet", custodyDomain: "demo-vault", mappingVersion: "demo" },
    goplus: demoGoplus("4663", directToken),
    lp: demoLp("4663", directToken, "25000"),
    policy,
    now,
  });

  const mockToken = "0x00000000000000000000000000000000000000b2";
  const refToken = "0x00000000000000000000000000000000000000c3";
  const reference = mk({
    asset: {
      chainId: "46630",
      token: mockToken,
      representation: "demo-ref.testnet",
      custodyDomain: "demo-vault",
      mappingVersion: "asset-identity-v2",
      reference: { chainId: "4663", token: refToken, registryEntryHash: "demo-registry-entry" },
    },
    goplus: demoGoplus("4663", refToken),
    lp: demoLp("4663", refToken, "40000"),
    policy,
    now,
  });

  const rejectToken = "0x00000000000000000000000000000000000000d4";
  const reject = mk({
    asset: { chainId: "4663", token: rejectToken, representation: "demo-reject.testnet", custodyDomain: "demo-vault", mappingVersion: "demo" },
    goplus: demoGoplus("4663", rejectToken, { sell_tax: "0.2" }),
    lp: demoLp("4663", rejectToken, "25000"),
    policy,
    now,
  });

  return [
    { report: direct, attribution: { arena: "demo.arena.testnet", battleId: 1, community: 0 }, provenance: "fixture" },
    { report: reference, attribution: { arena: "demo.arena.testnet", battleId: 1, community: 1 }, provenance: "fixture" },
    { report: reject, attribution: { arena: "demo.arena.testnet", battleId: 2, community: 0 }, provenance: "fixture" },
  ];
}

export async function runCli(
  args: string[],
  env: Record<string, string | undefined> = processEnv,
  io: CliIo = consoleIo,
  makeArchive: (dir: string) => ReportArchive = (dir) => new JsonFileReportArchive(archivePath(dir)),
): Promise<number> {
  const parsed = parseArgs(args);
  const dir = resolveDir(parsed, env);
  const archive = makeArchive(dir);
  const now = () => new Date();

  switch (parsed.command) {
    case "serve": {
      const port = parsed.flags.has("port") ? Number(parsed.flags.get("port")) : parseReportPort(env);
      const host = parsed.flags.get("host") ?? env.AUDIT_REPORT_HOST?.trim() ?? "127.0.0.1";
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        io.err("port must be an integer between 0 and 65535");
        return 1;
      }
      if (port === 0) {
        io.err("refusing to serve on port 0; pass --port or set AUDIT_REPORT_PORT");
        return 1;
      }
      const server = await startReportServer(port, { archive, now }, host);
      const addr = server?.address();
      const bound = addr && typeof addr === "object" ? `${host}:${addr.port}` : `${host}:${port}`;
      io.out(`audit report service reading ${archivePath(dir)} on http://${bound} (read-only)`);
      await new Promise<void>((resolve) => {
        const shutdown = () => {
          io.out("shutting down");
          server?.close(() => resolve());
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
      return 0;
    }
    case "list": {
      const page = queryObservations(await archive.snapshot(), queryFromFlags(parsed.flags), now());
      io.out(JSON.stringify({ items: page.items, nextCursor: page.nextCursor, pageSize: page.pageSize }, null, 2));
      return 0;
    }
    case "get": {
      const evidenceHash = parsed.positionals[0];
      if (!evidenceHash) {
        io.err("usage: get <evidenceHash> [--text] [--dir <path>]");
        return 1;
      }
      const observations = (await archive.snapshot()).filter((o) => o.report.evidenceHash === evidenceHash);
      if (observations.length === 0) {
        io.err(`no observations for evidence ${evidenceHash}`);
        return 1;
      }
      if (parsed.bools.has("text")) {
        const latest = [...observations].sort((a, b) => b.seq - a.seq)[0]!;
        io.out(formatAuditReport(latest.report));
      } else {
        const page = queryObservations(observations, queryFromFlags(parsed.flags), now());
        io.out(JSON.stringify({ evidenceHash, observations: page.items, nextCursor: page.nextCursor }, null, 2));
      }
      return 0;
    }
    case "seed-demo": {
      const inputs = buildDemoObservations();
      let created = 0;
      for (const input of inputs) {
        const put = await archive.put(input);
        if (put.created) created++;
      }
      io.out(
        `seeded ${created} new demo observation(s) (fixtures, not live data) into ${archivePath(dir)}; ` +
          `evidence hashes: ${inputs.map((i) => i.report.evidenceHash).join(", ")}`,
      );
      return 0;
    }
    default:
      io.err("usage: report-cli <serve|list|get|seed-demo> [--dir <path>] [--port <n>] [--host <h>] [filters]");
      return parsed.command === undefined ? 1 : 1;
  }
}

const invokedDirectly = (() => {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runCli(argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
