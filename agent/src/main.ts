import { DexHeuristicHoneypotSimulator, DexLiquiditySource, MarketAuditor } from "./auditor.js";
import { JsonFileBaselineStore } from "./baseline.js";
import { loadConfig } from "./config.js";
import { DexScreenerClient } from "./dexscreener.js";
import { MockStepExecutor } from "./executor.js";
import { createFetchHttpClient } from "./http.js";
import { runLoop } from "./loop.js";
import { createJsonLogger, errorMessage } from "./logger.js";
import { NearArenaClient } from "./near-client.js";
import { runOnce } from "./runtime.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { DexScreenerPriceSource, TwapFetcher } from "./twap.js";

async function main(): Promise<void> {
  const log = createJsonLogger();
  const cfg = loadConfig();
  const rt = loadRuntimeConfig();

  const dex = new DexScreenerClient({ http: createFetchHttpClient(), apiKey: cfg.dexscreenerApiKey });
  const priceSource = new DexScreenerPriceSource(dex);
  const liquidity = new DexLiquiditySource(dex);
  const deps = {
    client: NearArenaClient.fromConfig(cfg),
    auditor: new MarketAuditor(liquidity, new DexHeuristicHoneypotSimulator(dex)),
    baselines: new JsonFileBaselineStore(rt.baselinePath),
    twap: new TwapFetcher(priceSource),
    sampler: priceSource,
    liquidity,
    executor: new MockStepExecutor(),
    log,
  };

  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      log.info("shutdown requested", { signal: sig });
      stop.abort();
    });
  }

  // Only non-secret settings are logged; the key never leaves AgentConfig.
  log.info("agent starting", {
    network: cfg.network,
    arena: cfg.arenaContractId,
    agent: cfg.agentAccountId,
    intervalSecs: rt.intervalSecs,
    watchdogIntervalSecs: rt.watchdogIntervalSecs,
    executionMode: rt.executionMode,
  });

  await runLoop({
    pass: async (watchdog) => {
      const report = await runOnce({ ...deps, watchdog });
      log.info("pass complete", { ...report, watchdog });
    },
    intervalMs: rt.intervalSecs * 1000,
    watchdogIntervalMs: rt.watchdogIntervalSecs * 1000,
    signal: stop.signal,
    log,
  });
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", msg: errorMessage(err) }));
  process.exitCode = 1;
});
