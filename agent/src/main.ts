import { MarketAuditor } from "./auditor.js";
import { JsonFileBaselineStore } from "./baseline.js";
import { loadConfig } from "./config.js";
import { HealthState, attestationFromEnv, parseHealthPort, startHealthServer } from "./health.js";
import { SignerViewAddressResolver } from "./evm-address.js";
import { UniswapV3QuoterSource } from "./evm-quote.js";
import { FetchEvmRpc } from "./evm-rpc.js";
import { MockStepExecutor, type StepExecutor } from "./executor.js";
import { ForeignChainStepExecutor } from "./foreign-executor.js";
import { loadMarketConfig } from "./market-config.js";
import { createMarketData } from "./market-wiring.js";
import { OnChainStepExecutor } from "./onchain-executor.js";
import { MockDexQuoteSource } from "./quote.js";
import { RefQuoteSource } from "./ref-market.js";
import { runLoop } from "./loop.js";
import { createJsonLogger, errorMessage } from "./logger.js";
import { NearArenaClient, createNearTransport } from "./near-client.js";
import { checkExecutionMode, runOnce } from "./runtime.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { TwapFetcher } from "./twap.js";
import { AuditSubmitter } from "./audit/approval.js";
import { loadAuditConfig } from "./audit/config.js";
import { fetchGoPlusTokenSecurity } from "./audit/goplus-client.js";
import { createLifecycleAuditPass, NearLifecycleAuditSource } from "./audit/lifecycle-pass.js";
import type { AuditRecord } from "./audit/decision.js";
import { LifecycleLocker } from "./audit/lifecycle-lock.js";
import { createLpFetcher } from "./audit/lp-fetcher.js";
import { buildAuditPolicy } from "./audit/policy.js";
import { AuditReportStore } from "./audit/report.js";
import { NearReferenceRegistrySource } from "./reference-registry.js";
import { withEvmReadRetries } from "./rpc-resilience.js";
import { createPayoutReconciler, loadPayoutReconcileConfig } from "./payout-wiring.js";

async function main(): Promise<void> {
  const log = createJsonLogger();
  const cfg = loadConfig();
  const rt = loadRuntimeConfig();

  const market = loadMarketConfig(process.env, rt.intervalSecs);
  const transport = createNearTransport(cfg);
  const client = new NearArenaClient(cfg.arenaContractId, transport);
  let executor: StepExecutor = new MockStepExecutor();
  if (rt.foreign) {
    const f = rt.foreign;
    const rpc = new FetchEvmRpc(f.rpcUrl);
    executor = new ForeignChainStepExecutor(
      {
        chainId: f.chainId,
        usdc: f.usdc,
        tokenMap: f.tokenMap,
        feeTier: f.feeTier,
        confirmations: f.confirmations,
      },
      {
        client,
        rpc,
        // The signer account comes from the arena's own configuration, read when first needed.
        resolver: new SignerViewAddressResolver(
          transport,
          async () => {
            const foreignCfg = await client.getForeignConfig();
            if (!foreignCfg) throw new Error("the arena has no foreign signing configuration");
            return foreignCfg.mpc_contract;
          },
          cfg.arenaContractId,
        ),
        quotes: new UniswapV3QuoterSource(rpc, f.quoter, rt.slippageBps),
        log,
      },
    );
  }
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
    executor,
    onChainExecutor:
      rt.executionMode === "onchain"
        ? new OnChainStepExecutor(
            client,
            market.marketData === "ref" && market.refExchangeId
              ? new RefQuoteSource(transport, market.refExchangeId)
              : new MockDexQuoteSource(transport),
            {
            slippageBps: rt.slippageBps,
            stepTimeoutMs: rt.stepTimeoutSecs * 1000,
            log,
          })
        : undefined,
    executionMode: rt.executionMode,
    log,
  };

  // Lifecycle audit (GoPlus + independent LP): only when AUDIT_ENABLED=true.
  const auditCfg = loadAuditConfig(process.env, rt.intervalSecs);
  const auditSource = new NearLifecycleAuditSource(cfg.arenaContractId, transport);
  const auditRecords = new Map<string, AuditRecord>();
  const lifecycleAudit = auditCfg
    ? createLifecycleAuditPass({
        source: auditSource,
        // The lock step is separate (lifecycle-lock.ts) and off unless AUDIT_LOCK_ENABLED=true.
        ...(auditCfg.lockEnabled
          ? {
              lock: new LifecycleLocker({
                contractId: cfg.arenaContractId,
                transport,
                records: auditRecords,
                now: () => new Date(),
                isLocked: async (id) => (await auditSource.get(id))?.locked === true,
                log,
              }),
            }
          : {}),
        refresh: {
          policy: buildAuditPolicy({ ttlSeconds: auditCfg.ttlSeconds }),
          // The single protocol-controlled source of reference mappings, shared with scoring.
          registry: new NearReferenceRegistrySource(cfg.arenaContractId, transport),
          now: () => new Date(),
          refreshAheadMs: rt.intervalSecs * 2000,
          fetchGoPlus: (q) =>
            fetchGoPlusTokenSecurity(
              q,
              auditCfg.goplusAccessToken ? { accessToken: auditCfg.goplusAccessToken } : {},
            ),
          fetchLp: createLpFetcher({
            rpc: withEvmReadRetries(new FetchEvmRpc(auditCfg.referenceRpcUrl)),
            stablecoins: auditCfg.stablecoins,
            pools: auditCfg.pools,
            ...(auditCfg.weth ? { weth: auditCfg.weth } : {}),
          }),
          submitter: new AuditSubmitter(cfg.arenaContractId, transport),
          records: auditRecords,
        },
        reports: new AuditReportStore(),
        log,
      })
    : undefined;

  // Payout restart reconciliation: only when PAYOUT_RECONCILE_ENABLED=true. It runs before the
  // first pass and on every pass; it never requests a signature or creates a spend.
  const payoutCfg = loadPayoutReconcileConfig(process.env);
  const payoutReconciler = payoutCfg ? createPayoutReconciler(payoutCfg, cfg, log) : undefined;

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
    slippageBps: rt.executionMode === "mock" ? undefined : rt.slippageBps,
    stepTimeoutSecs: rt.executionMode === "onchain" ? rt.stepTimeoutSecs : undefined,
    foreignChainId: rt.foreign?.chainId,
    foreignConfirmations: rt.foreign?.confirmations,
  });
  if (rt.foreign) {
    log.warn(`foreign-chain execution is on: this moves real value on chain ${rt.foreign.chainId}`);
  }

  // Startup check; runOnce repeats it every pass and pauses settlement on a mismatch.
  try {
    const problem = await checkExecutionMode(client, rt.executionMode);
    if (problem) log.error(`${problem}; settlement passes will not run`);
  } catch (err) {
    log.warn("could not verify execution mode at startup", { error: errorMessage(err) });
  }

  await runLoop({
    pass: async (watchdog) => {
      if (payoutReconciler) {
        const payouts = await payoutReconciler.reconcile();
        log.info("payout reconciliation complete", { unresolved: payouts.unresolved, errors: payouts.errors });
      }
      const report = await runOnce({ ...deps, watchdog, ...(lifecycleAudit ? { lifecycleAudit } : {}) });
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
