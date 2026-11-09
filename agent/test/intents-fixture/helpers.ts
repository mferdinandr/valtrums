import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assetByMainnetId } from "../../src/intents-fixture/assets.js";
import { FixtureCustody } from "../../src/intents-fixture/custody.js";
import { IntentsFixtureService } from "../../src/intents-fixture/service.js";
import { FakeSolver, type SolverMode } from "../../src/intents-fixture/solver.js";

/** The recorded real mainnet responses (docs/evidence/2026-11-09-intents-routes.json). Never fetched in tests. */
export interface Recording {
  tokenCount: number;
  blockchains: Record<string, number>;
  robinhoodMainnetAssets: { symbol: string; assetId: string; contractAddress: string | null; decimals: number }[];
  testnetAssets: unknown[];
  dryQuotes: Record<
    string,
    { request: Record<string, string | boolean>; amountIn: string; amountOut: string; minAmountOut: string; timeEstimate: number; depositAddress: null }
  >;
}
export const recording: Recording = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../docs/evidence/2026-11-09-intents-routes.json", import.meta.url)), "utf8"),
);

export const NOW = 1_800_000_000_000;

export function makeFixture(mode: SolverMode = "complete") {
  let clock = NOW;
  const custody = new FixtureCustody();
  const solver = new FakeSolver(custody, mode);
  const lines: Record<string, unknown>[] = [];
  const service = new IntentsFixtureService({
    solver,
    network: "testnet",
    now: () => clock,
    logger: { info: (m, f) => lines.push({ m, ...f }), warn() {}, error() {} },
  });
  const call = (method: string, url: string, body?: unknown) => service.handle({ method, url, ...(body !== undefined ? { body } : {}) });
  return { service, custody, solver, lines, call, tick: (ms: number) => (clock += ms) };
}

export const fixtureId = (mainnetAssetId: string): string => {
  const a = assetByMainnetId(mainnetAssetId);
  if (!a) throw new Error(`no fixture asset for ${mainnetAssetId}`);
  return a.fixtureAssetId;
};
