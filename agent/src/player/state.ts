import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * What the agent program remembers between runs. It is only a guard against repeating itself; the chain is the
 * source of truth for budgets and reservations, so losing this file cannot double-spend (a repeated `reserve`
 * with the same request identity is idempotent on chain).
 */
export interface ActedEntry {
  at: number;
  actionId: string;
  txHash: string | null;
  status: string;
}
export interface PlayerStateData {
  version: 1;
  acted: Record<string, ActedEntry>;
  /** `key -> until (ms)`: a community the service refused, not retried until then. */
  blocked: Record<string, number>;
  failures: number;
}

export const stateKey = (user: string, localId: string, battleId: number, community: number): string => `${user}:${localId}:${battleId}:${community}`;

const empty = (): PlayerStateData => ({ version: 1, acted: {}, blocked: {}, failures: 0 });

function parse(raw: string): PlayerStateData {
  const v = JSON.parse(raw) as Partial<PlayerStateData>;
  if (v.version !== 1 || typeof v.acted !== "object" || v.acted === null || typeof v.blocked !== "object" || v.blocked === null || typeof v.failures !== "number") {
    throw new Error("player state file is malformed");
  }
  return { version: 1, acted: v.acted as Record<string, ActedEntry>, blocked: v.blocked as Record<string, number>, failures: v.failures };
}

/** A versioned JSON file with atomic writes. A malformed file stops the program instead of being silently reset. */
export class PlayerState {
  private data: PlayerStateData;
  constructor(private readonly path: string | null) {
    this.data = path && existsSync(path) ? parse(readFileSync(path, "utf8")) : empty();
  }
  has(key: string): boolean {
    return key in this.data.acted;
  }
  isBlocked(key: string, now: number): boolean {
    return (this.data.blocked[key] ?? 0) > now;
  }
  actedSince(sinceMs: number): number {
    return Object.values(this.data.acted).filter((a) => a.at >= sinceMs).length;
  }
  get failures(): number {
    return this.data.failures;
  }
  markActed(key: string, entry: ActedEntry): void {
    this.data.acted[key] = entry;
    this.data.failures = 0;
    this.save();
  }
  markBlocked(key: string, untilMs: number): void {
    this.data.blocked[key] = untilMs;
    this.save();
  }
  recordFailure(): number {
    this.data.failures += 1;
    this.save();
    return this.data.failures;
  }
  resetFailures(): void {
    if (this.data.failures === 0) return;
    this.data.failures = 0;
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
