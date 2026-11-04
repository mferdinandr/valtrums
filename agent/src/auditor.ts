import type { ArenaClient } from "./client.js";
import type { DexPair, DexScreenerClient } from "./dexscreener.js";
import type { BattleView } from "./types.js";

export const MIN_LIQUIDITY_USD = 10_000;

export interface HoneypotResult {
  honeypot: boolean;
  detail: string;
}

/** Decides whether a token can be sold. Implementations may use a real buy/sell simulation. */
export interface HoneypotSimulator {
  check(token: string): Promise<HoneypotResult>;
}

/** Source of the liquidity figure the audit gates on. */
export interface LiquiditySource {
  liquidityUsd(token: string): Promise<number>;
}

export interface TokenAudit {
  token: string;
  /** Baseline liquidity at audit time; the watchdog compares against this. */
  liquidityUsd: number;
  lowLiquidity: boolean;
  honeypot: boolean;
  honeypotDetail: string;
}

export interface AuditResult {
  battleId: number;
  passed: boolean;
  /** Void reason when not passed; empty when passed. */
  reason: string;
  tokens: [TokenAudit, TokenAudit];
}

/**
 * DexScreener-backed liquidity: sum of USD liquidity over all pairs of the
 * token on the configured chain.
 */
export class DexLiquiditySource implements LiquiditySource {
  constructor(private readonly dex: DexScreenerClient) {}
  async liquidityUsd(token: string): Promise<number> {
    const pairs = await this.dex.getPairs(token);
    return pairs.reduce((sum, p) => sum + p.liquidityUsd, 0);
  }
}

/**
 * Heuristic honeypot detector over DexScreener 24h trade counts.
 *
 * Limits (this is NOT a transaction simulation): DexScreener exposes no sell
 * simulation, so a token is flagged when it has pairs but every observed 24h
 * trade is a buy (>= minBuys buys, zero sells), the typical footprint of a
 * token that cannot be sold. It cannot detect sell taxes, honeypots with no
 * recent trades, or tokens that block only specific wallets. A token with no
 * pair at all is also flagged, since nothing can be sold. Swap in a real
 * simulator by implementing HoneypotSimulator.
 */
export class DexHeuristicHoneypotSimulator implements HoneypotSimulator {
  constructor(
    private readonly dex: DexScreenerClient,
    private readonly minBuys = 10,
  ) {}

  async check(token: string): Promise<HoneypotResult> {
    const pairs: DexPair[] = await this.dex.getPairs(token);
    if (pairs.length === 0) return { honeypot: true, detail: "no trading pair found" };
    const buys = pairs.reduce((s, p) => s + p.buys24h, 0);
    const sells = pairs.reduce((s, p) => s + p.sells24h, 0);
    if (sells === 0 && buys >= this.minBuys) {
      return { honeypot: true, detail: `${buys} buys and no sells in 24h` };
    }
    return { honeypot: false, detail: `${buys} buys, ${sells} sells in 24h` };
  }
}

export class MarketAuditor {
  constructor(
    private readonly liquidity: LiquiditySource,
    private readonly honeypot: HoneypotSimulator,
    private readonly minLiquidityUsd = MIN_LIQUIDITY_USD,
  ) {}

  /** Throws if any data source fails: an unverifiable battle must stay Proposed, not be voided. */
  async audit(battle: BattleView): Promise<AuditResult> {
    const [a, b] = await Promise.all([
      this.auditToken(battle.token_a),
      this.auditToken(battle.token_b),
    ]);
    const reasons: string[] = [];
    for (const t of [a, b]) {
      if (t.lowLiquidity) {
        reasons.push(
          `low liquidity: ${t.token} has $${t.liquidityUsd.toFixed(2)}, needs more than $${this.minLiquidityUsd}`,
        );
      }
    }
    for (const t of [a, b]) {
      if (t.honeypot) reasons.push(`honeypot: ${t.token} (${t.honeypotDetail})`);
    }
    return {
      battleId: battle.id,
      passed: reasons.length === 0,
      reason: reasons.join("; "),
      tokens: [a, b],
    };
  }

  private async auditToken(token: string): Promise<TokenAudit> {
    const [liquidityUsd, hp] = await Promise.all([
      this.liquidity.liquidityUsd(token),
      this.honeypot.check(token),
    ]);
    return {
      token,
      liquidityUsd,
      lowLiquidity: !(liquidityUsd > this.minLiquidityUsd),
      honeypot: hp.honeypot,
      honeypotDetail: hp.detail,
    };
  }
}

export type AuditOutcome =
  | { action: "approved" | "voided"; result: AuditResult }
  | { action: "skipped"; reason: string };

/**
 * Audit one battle and act on it. Re-reads the battle first so duplicate or
 * stale work items become no-ops. Data-source errors propagate and nothing is
 * written, so the battle is retried on the next planning pass.
 */
export async function auditAndAct(
  client: ArenaClient,
  auditor: MarketAuditor,
  battleId: number,
): Promise<AuditOutcome> {
  const battle = await client.getBattle(battleId);
  if (!battle) return { action: "skipped", reason: "battle not found" };
  if (battle.status !== "Proposed") {
    return { action: "skipped", reason: `status is ${battle.status}` };
  }
  const result = await auditor.audit(battle);
  if (result.passed) {
    await client.approveBattle(battleId);
    return { action: "approved", result };
  }
  await client.voidBattle(battleId, result.reason);
  return { action: "voided", result };
}
