import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ClaimEntry {
  at: number;
  txHash: string | null;
  /** True between reserving a claim and its transfer finishing. */
  pending: boolean;
}
interface LedgerData {
  version: 1;
  claims: Record<string, ClaimEntry>;
  /** Timestamps of recent transfers, for the hourly bound. */
  sent: number[];
}

const HOUR_MS = 3_600_000;
export const claimKey = (account: string, symbol: string): string => `${account}|${symbol}`;

function parse(raw: string): LedgerData {
  const v = JSON.parse(raw) as Partial<LedgerData>;
  if (v.version !== 1 || typeof v.claims !== "object" || v.claims === null || !Array.isArray(v.sent)) throw new Error("faucet ledger is malformed");
  return { version: 1, claims: v.claims as Record<string, ClaimEntry>, sent: v.sent.filter((n): n is number => typeof n === "number") };
}

/**
 * Who claimed what and when. A claim is reserved before its transfer and released if the transfer fails, so a crash
 * between the two keeps the account in cooldown instead of paying twice. A malformed file stops the faucet.
 */
export class FaucetLedger {
  private data: LedgerData;
  constructor(private readonly path: string | null) {
    this.data = path && existsSync(path) ? parse(readFileSync(path, "utf8")) : { version: 1, claims: {}, sent: [] };
  }
  lastClaim(account: string, symbol: string): ClaimEntry | null {
    return this.data.claims[claimKey(account, symbol)] ?? null;
  }
  sentSince(sinceMs: number): number {
    return this.data.sent.filter((t) => t >= sinceMs).length;
  }
  reserve(account: string, symbol: string, now: number): void {
    this.data.claims[claimKey(account, symbol)] = { at: now, txHash: null, pending: true };
    this.data.sent.push(now);
    this.data.sent = this.data.sent.filter((t) => t >= now - HOUR_MS);
    this.save();
  }
  complete(account: string, symbol: string, txHash: string): void {
    const e = this.data.claims[claimKey(account, symbol)];
    if (e) {
      e.txHash = txHash;
      e.pending = false;
      this.save();
    }
  }
  release(account: string, symbol: string, previous: ClaimEntry | null, now: number): void {
    if (previous) this.data.claims[claimKey(account, symbol)] = previous;
    else delete this.data.claims[claimKey(account, symbol)];
    const i = this.data.sent.lastIndexOf(now);
    if (i >= 0) this.data.sent.splice(i, 1);
    this.save();
  }
  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
