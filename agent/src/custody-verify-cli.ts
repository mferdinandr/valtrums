/**
 * Read-only CLI: run the custody verifier against one deposit transaction on a live RPC and print a
 * JSON timeline of verdicts until the receipt is verified, rejected or the wait expires.
 * It signs and sends nothing and holds no secrets. The RPC URL is never printed.
 *
 *   node dist/custody-verify-cli.js --rpc <url> --tx <hash> --log-index <n> --token <addr> --custody <addr>
 *     --mapping-version <n> [--battle <n>] [--chain-id 46630] [--wait-seconds 1800] [--poll-seconds 30] [--max-depth 256] [--state-rpc <url>]
 */
import { verifyDeposit, type AssetMapping, type Verdict } from "./custody-verifier.js";
import { RpcFinalitySource } from "./evm-finality-source.js";

export interface TimelineEntry { at: string; elapsedSeconds: number; latestFinalized: string | null; verdict: string; reason?: string; attestation?: unknown }

const serialize = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

export async function pollVerdicts(
  source: RpcFinalitySource, mapping: AssetMapping, request: { transactionHash: string; logIndex: number; battleId?: bigint },
  opts: { waitSeconds: number; pollSeconds: number; maxAncestryDepth?: bigint; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<TimelineEntry[]> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  const timeline: TimelineEntry[] = [];
  for (;;) {
    const verdict: Verdict = await verifyDeposit(source, mapping, request, opts.maxAncestryDepth !== undefined ? { maxAncestryDepth: opts.maxAncestryDepth } : {});
    const fin = await source.finalizedBlock();
    const reasonOrNone = verdict.status === "verified" ? undefined : verdict.reason;
    const last = timeline[timeline.length - 1];
    if (!last || last.verdict !== verdict.status || last.reason !== reasonOrNone) {
      timeline.push({
        at: new Date(now()).toISOString(), elapsedSeconds: Math.round((now() - start) / 1000),
        latestFinalized: fin ? fin.number.toString() : null, verdict: verdict.status,
        ...(reasonOrNone ? { reason: reasonOrNone } : {}),
        ...(verdict.status === "verified" ? { attestation: serialize(verdict.attestation) } : {}),
      });
    }
    if (verdict.status !== "pending" || now() - start >= opts.waitSeconds * 1000) return timeline;
    await sleep(opts.pollSeconds * 1000);
  }
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

async function main(): Promise<void> {
  const mapping: AssetMapping = {
    chainId: BigInt(arg("chain-id", "46630")), token: arg("token"), custody: arg("custody"),
    custodyDomain: arg("custody-domain", "robinhood-testnet"), representation: arg("representation", "unset.testnet"),
    mappingVersion: BigInt(arg("mapping-version")),
  };
  const battle = process.argv.includes("--battle") ? BigInt(arg("battle")) : undefined;
  const source = new RpcFinalitySource(arg("rpc"), process.argv.includes("--state-rpc") ? { stateUrl: arg("state-rpc") } : {});
  const timeline = await pollVerdicts(
    source, mapping,
    { transactionHash: arg("tx"), logIndex: Number(arg("log-index")), ...(battle !== undefined ? { battleId: battle } : {}) },
    { waitSeconds: Number(arg("wait-seconds", "0")), pollSeconds: Number(arg("poll-seconds", "30")), maxAncestryDepth: BigInt(arg("max-depth", "256")) },
  );
  console.log(JSON.stringify({ chainId: mapping.chainId.toString(), tx: arg("tx"), timeline }, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : "failed"); process.exit(1); });
}
