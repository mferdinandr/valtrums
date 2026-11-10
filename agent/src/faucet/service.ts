import { isNearAccount, type FaucetConfig, type FaucetToken } from "./config.js";
import { FaucetLedger } from "./ledger.js";

/** What the faucet needs from the chain. Injected so it can be tested without one. */
export interface FaucetChain {
  balanceOf(token: string, account: string): Promise<bigint>;
  isRegistered(token: string, account: string): Promise<boolean>;
  /** Minimum storage deposit in yoctoNEAR. */
  storageMin(token: string): Promise<bigint>;
  register(token: string, account: string, depositYocto: bigint): Promise<void>;
  /** Transfers from the faucet account and returns the transaction hash. */
  transfer(token: string, receiver: string, amount: bigint): Promise<string>;
}

export type ClaimStatus = "sent" | "dry_run" | "cooldown" | "empty" | "hourly_limit" | "error";
export interface ClaimResult {
  symbol: string;
  status: ClaimStatus;
  amount: string;
  txHash?: string;
  retryAfterMs?: number;
  message?: string;
}
export interface TokenStatus {
  symbol: string;
  representation: string;
  amount: string;
  cooldownRemainingMs: number;
  available: boolean;
}

export class FaucetService {
  /** One claim at a time per account, so two parallel requests cannot both pass the cooldown check. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly cfg: FaucetConfig,
    private readonly chain: FaucetChain,
    private readonly ledger: FaucetLedger,
    private readonly opts: { live: boolean; now?: () => number },
  ) {}

  get live(): boolean {
    return this.opts.live;
  }
  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }
  get tokens(): readonly FaucetToken[] {
    return this.cfg.tokens;
  }

  async status(account: string): Promise<TokenStatus[]> {
    const out: TokenStatus[] = [];
    for (const t of this.cfg.tokens) {
      const last = this.ledger.lastClaim(account, t.symbol);
      const remaining = last ? Math.max(0, last.at + this.cfg.cooldownMs - this.now) : 0;
      let available = false;
      try {
        available = (await this.chain.balanceOf(t.representation, this.cfg.account)) >= BigInt(t.amount);
      } catch {
        available = false;
      }
      out.push({ symbol: t.symbol, representation: t.representation, amount: t.amount, cooldownRemainingMs: remaining, available });
    }
    return out;
  }

  /** Claims the named tokens (all when none are named) for `account`, which must come from a verified session. */
  claim(account: string, symbols?: readonly string[]): Promise<ClaimResult[]> {
    const prev = this.locks.get(account) ?? Promise.resolve();
    const run = prev.then(() => this.claimNow(account, symbols), () => this.claimNow(account, symbols));
    this.locks.set(account, run);
    // The caller handles `run`'s rejection; this tail only cleans up and must never reject on its own.
    void run
      .finally(() => {
        if (this.locks.get(account) === run) this.locks.delete(account);
      })
      .catch(() => undefined);
    return run;
  }

  private async claimNow(account: string, symbols?: readonly string[]): Promise<ClaimResult[]> {
    if (!isNearAccount(account) || account === this.cfg.account) throw new Error("this account cannot claim");
    const wanted = symbols && symbols.length > 0 ? symbols.map((s) => s.toUpperCase()) : this.cfg.tokens.map((t) => t.symbol);
    const unknown = wanted.find((s) => !this.cfg.tokens.some((t) => t.symbol === s));
    if (unknown) throw new Error(`unknown token ${unknown}`);
    const results: ClaimResult[] = [];
    for (const symbol of [...new Set(wanted)]) {
      results.push(await this.claimToken(account, this.cfg.tokens.find((t) => t.symbol === symbol)!));
    }
    return results;
  }

  private async claimToken(account: string, t: FaucetToken): Promise<ClaimResult> {
    const base = { symbol: t.symbol, amount: t.amount };
    const now = this.now;
    const last = this.ledger.lastClaim(account, t.symbol);
    if (last && now < last.at + this.cfg.cooldownMs) return { ...base, status: "cooldown", retryAfterMs: last.at + this.cfg.cooldownMs - now };
    if (this.ledger.sentSince(now - 3_600_000) >= this.cfg.maxPerHour) return { ...base, status: "hourly_limit", message: "the faucet is busy, try again later" };
    try {
      if ((await this.chain.balanceOf(t.representation, this.cfg.account)) < BigInt(t.amount)) return { ...base, status: "empty", message: "the faucet has run out of this token" };
      if (!this.opts.live) return { ...base, status: "dry_run", message: "dry run: nothing was sent" };
    } catch (e) {
      return { ...base, status: "error", message: e instanceof Error ? e.message : String(e) };
    }
    // Reserve before sending: a crash after this point keeps the account in cooldown rather than paying twice.
    this.ledger.reserve(account, t.symbol, now);
    try {
      if (!(await this.chain.isRegistered(t.representation, account))) {
        await this.chain.register(t.representation, account, await this.chain.storageMin(t.representation));
      }
      const txHash = await this.chain.transfer(t.representation, account, BigInt(t.amount));
      this.ledger.complete(account, t.symbol, txHash);
      return { ...base, status: "sent", txHash };
    } catch (e) {
      this.ledger.release(account, t.symbol, last, now);
      return { ...base, status: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }
}
