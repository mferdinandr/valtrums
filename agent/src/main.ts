import { DexHeuristicHoneypotSimulator, DexLiquiditySource, MarketAuditor } from "./auditor.js";
import { JsonFileBaselineStore } from "./baseline.js";
import { loadConfig } from "./config.js";
import { DexScreenerClient } from "./dexscreener.js";
import { MockStepExecutor } from "./executor.js";
import { OnChainStepExecutor } from "./onchain-executor.js";
import { MockDexQuoteSource } from "./quote.js";
import { createFetchHttpClient } from "./http.js";
import { runLoop } from "./loop.js";
import { createJsonLogger, errorMessage } from "./logger.js";
import { NearArenaClient, createNearTransport } from "./near-client.js";
import { checkExecutionMode, runOnce } from "./runtime.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { DexScreenerPriceSource, TwapFetcher } from "./twap.js";

async function main(): Promise<void> {
  const log = createJsonLogger();
  const cfg = loadConfig();
  const rt = loadRuntimeConfig();

  const dex = new DexScreenerClient({ http: createFetchHttpClient(), apiKey: cfg.dexscreenerApiKey });
  const priceSource = new DexScreenerPriceSource(dex);
  const liquidity = new DexLiquiditySource(dex);
  const transport = createNearTransport(cfg);
  const client = new NearArenaClient(cfg.arenaContractId, transport);
  const deps = {
    client,
    auditor: new MarketAuditor(liquidity, new DexHeuristicHoneypotSimulator(dex)),
    baselines: new JsonFileBaselineStore(rt.baselinePath),
    twap: new TwapFetcher(priceSource),
    sampler: priceSource,
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
