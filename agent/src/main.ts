import { MarketAuditor } from "./auditor.js";
import { JsonFileBaselineStore } from "./baseline.js";
import { loadConfig } from "./config.js";
import { HealthState, attestationFromEnv, parseHealthPort, startHealthServer } from "./health.js";
import { loadMarketConfig } from "./market-config.js";
import { createMarketData } from "./market-wiring.js";
import { MockStepExecutor } from "./executor.js";
import { OnChainStepExecutor } from "./onchain-executor.js";
import { MockDexQuoteSource } from "./quote.js";
import { runLoop } from "./loop.js";
import { createJsonLogger, errorMessage } from "./logger.js";
import { NearArenaClient, createNearTransport } from "./near-client.js";
import { checkExecutionMode, runOnce } from "./runtime.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { TwapFetcher } from "./twap.js";

async function main(): Promise<void> {
  const log = createJsonLogger();
  const cfg = loadConfig();
  const rt = loadRuntimeConfig();

  const market = loadMarketConfig(process.env, rt.intervalSecs);
  const transport = createNearTransport(cfg);
  const client = new NearArenaClient(cfg.arenaContractId, transport);
  const { priceSource, sampler, liquidity, honeypot } = await createMarketData(
    market,
    client,
    transport,
    cfg.dexscreenerApiKey,
  );
  const deps = {
    client,
    auditor: new MarketAuditor(liquidity, honeypot, market.minLiquidityUsd),
    baselines: new JsonFileBaselineStore(rt.baselinePath),
    twap: new TwapFetcher(priceSource, {
      windowMs: market.twapWindowSecs * 1000,
      sampleIntervalMs: rt.intervalSecs * 1000,
    }),
    sampler,
    liquidity,
    executor: new MockStepExecutor(),
    onChainExecutor:
      rt.executionMode === "onchain"
        ? new OnChainStepExecutor(client, new MockDexQuoteSource(transport), {
            slippageBps: rt.slippageBps,
            stepTimeoutMs: rt.stepTimeoutSecs * 1000,
            log,
          })
        : undefined,
    executionMode: rt.executionMode,
    log,
  };

  const health = new HealthState(rt.intervalSecs * 1000);
  const healthServer = await startHealthServer(
    parseHealthPort(process.env),
    health,
    attestationFromEnv(process.env, {
      agentAccountId: cfg.agentAccountId,
      executionMode: rt.executionMode,
      contractId: cfg.arenaContractId,
    }),
  );

  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      log.info("shutdown requested", { signal: sig });
      stop.abort();
      healthServer?.close();
    });
  }

  // Only non-secret settings are logged; the key never leaves AgentConfig.
  log.info("agent starting", {
    network: cfg.network,
    arena: cfg.arenaContractId,
    agent: cfg.agentAccountId,
    intervalSecs: rt.intervalSecs,
    watchdogIntervalSecs: rt.watchdogIntervalSecs,
    marketData: market.marketData,
    twapWindowSecs: market.twapWindowSecs,
    minLiquidityUsd: market.minLiquidityUsd,
    executionMode: rt.executionMode,
    slippageBps: rt.executionMode === "onchain" ? rt.slippageBps : undefined,
    stepTimeoutSecs: rt.executionMode === "onchain" ? rt.stepTimeoutSecs : undefined,
  });

  // Startup check; runOnce repeats it every pass and pauses settlement on a mismatch.
  try {
    const problem = await checkExecutionMode(client, rt.executionMode);
    if (problem) log.error(`${problem}; settlement passes will not run`);
  } catch (err) {
    log.warn("could not verify execution mode at startup", { error: errorMessage(err) });
  }

  await runLoop({
    pass: async (watchdog) => {
      const report = await runOnce({ ...deps, watchdog });
      if (report.errors === 0) health.markPassSucceeded();
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
