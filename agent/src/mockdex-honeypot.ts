import type { HoneypotResult, HoneypotSimulator } from "./auditor.js";
import type { MockDexMarket } from "./mockdex-market.js";

/**
 * Honeypot check against the mock DEX. A token passes only if it can be sold
 * (token to USDC has a non-zero rate), bought (USDC to token has a non-zero
 * rate) and the DEX holds some of it. Data-source errors propagate, so an
 * unverifiable token is retried instead of voided.
 * FIXTURE: the mock DEX is an owner-controlled demonstration market, not evidence of real liquidity or safety.
 */
export class MockDexHoneypotSimulator implements HoneypotSimulator {
  constructor(private readonly market: MockDexMarket) {}

  async check(token: string): Promise<HoneypotResult> {
    const { usdc, dex } = this.market;
    const [sell, buy, liquidity] = await Promise.all([
      this.market.rate(token, usdc),
      this.market.rate(usdc, token),
      this.market.rawLiquidity(token),
    ]);
    const problems: string[] = [];
    if (!sell) problems.push(`no ${token} to USDC rate, it cannot be sold`);
    if (!buy) problems.push(`no USDC to ${token} rate, it cannot be bought`);
    if (liquidity === 0n) problems.push(`${dex} holds none of it`);
    if (problems.length > 0) return { honeypot: true, detail: problems.join(", ") };
    return { honeypot: false, detail: "both directions priced and the DEX holds the token" };
  }
}
