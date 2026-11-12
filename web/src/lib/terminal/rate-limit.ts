// Bounds on how much NEAR AI the Terminal route can spend. The route is public (a prompt is read before any wallet is
// involved), so without limits anyone could burn the model credits. Every limit degrades to the built-in rules, which
// cost nothing, instead of failing the request. Counters are in memory: they hold per server instance (see the design
// note about shared stores for a multi-instance deployment).

export interface TerminalLimits {
  /** False turns the model off for everyone (kill switch); the built-in rules still answer. */
  aiEnabled: boolean;
  /** Model calls one client may cause per hour. */
  aiPerClientHour: number;
  /** Model calls in total per hour and per day (a cap on the spend, whoever asks). */
  aiGlobalHour: number;
  aiGlobalDay: number;
  /** Model calls running at the same moment on this instance. */
  aiConcurrent: number;
  /** Requests of any kind (rules included) one client may send per minute; beyond it the request is refused. */
  requestsPerClientMinute: number;
}

/** Conservative defaults: about 0.0003 USD per call, so the daily cap is at most a few tenths of a dollar. */
export const DEFAULT_TERMINAL_LIMITS: TerminalLimits = {
  aiEnabled: true,
  aiPerClientHour: 10,
  aiGlobalHour: 200,
  aiGlobalDay: 1_000,
  aiConcurrent: 4,
  requestsPerClientMinute: 30,
};

const positive = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : fallback;
};

/** Limits from the server environment. An invalid value keeps the default rather than turning a limit off. */
export function terminalLimitsFromEnv(env: Record<string, string | undefined>): TerminalLimits {
  const d = DEFAULT_TERMINAL_LIMITS;
  return {
    aiEnabled: env.TERMINAL_AI_ENABLED?.trim().toLowerCase() !== "false",
    aiPerClientHour: positive(env.TERMINAL_AI_PER_CLIENT_HOUR, d.aiPerClientHour),
    aiGlobalHour: positive(env.TERMINAL_AI_GLOBAL_HOUR, d.aiGlobalHour),
    aiGlobalDay: positive(env.TERMINAL_AI_GLOBAL_DAY, d.aiGlobalDay),
    aiConcurrent: positive(env.TERMINAL_AI_CONCURRENT, d.aiConcurrent),
    requestsPerClientMinute: positive(env.TERMINAL_REQUESTS_PER_CLIENT_MINUTE, d.requestsPerClientMinute),
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Clients remembered at once. Beyond it the oldest are dropped, so the table cannot grow without bound. */
const MAX_CLIENTS = 10_000;

export type AiDecision = { allowed: true; release: () => void } | { allowed: false; reason: string };

/** Sliding-window counters for the Terminal route. */
export class TerminalGuard {
  private readonly perClientAi = new Map<string, number[]>();
  private readonly perClientRequests = new Map<string, number[]>();
  private readonly globalAi: number[] = [];
  private running = 0;

  constructor(private readonly limits: TerminalLimits, private readonly now: () => number = Date.now) {}

  get settings(): TerminalLimits {
    return this.limits;
  }

  private static prune(list: number[], since: number): void {
    while (list.length > 0 && list[0]! <= since) list.shift();
  }

  private static touch(map: Map<string, number[]>, key: string): number[] {
    const existing = map.get(key);
    if (existing) {
      map.delete(key); // keep the most recently used clients last
      map.set(key, existing);
      return existing;
    }
    if (map.size >= MAX_CLIENTS) map.delete(map.keys().next().value as string);
    const fresh: number[] = [];
    map.set(key, fresh);
    return fresh;
  }

  /** Counts a request from this client. False means it is over the per-minute limit and should be refused. */
  allowRequest(client: string): boolean {
    const now = this.now();
    const list = TerminalGuard.touch(this.perClientRequests, client);
    TerminalGuard.prune(list, now - MINUTE);
    if (list.length >= this.limits.requestsPerClientMinute) return false;
    list.push(now);
    return true;
  }

  /**
   * May this client cause one more model call? A call that is allowed is counted at once and holds a concurrency slot
   * until `release` is called. A call that is refused costs nothing and the rules answer instead.
   */
  tryAi(client: string): AiDecision {
    const now = this.now();
    if (!this.limits.aiEnabled) return { allowed: false, reason: "NEAR AI is switched off on this server" };
    if (this.running >= this.limits.aiConcurrent) return { allowed: false, reason: "NEAR AI is busy" };
    TerminalGuard.prune(this.globalAi, now - DAY);
    const lastDay = this.globalAi.length;
    if (lastDay >= this.limits.aiGlobalDay) return { allowed: false, reason: "the daily NEAR AI budget of this server is used up" };
    const lastHour = this.globalAi.filter((t) => t > now - HOUR).length;
    if (lastHour >= this.limits.aiGlobalHour) return { allowed: false, reason: "the hourly NEAR AI budget of this server is used up" };
    const mine = TerminalGuard.touch(this.perClientAi, client);
    TerminalGuard.prune(mine, now - HOUR);
    if (mine.length >= this.limits.aiPerClientHour) return { allowed: false, reason: `you reached ${this.limits.aiPerClientHour} NEAR AI requests this hour` };
    mine.push(now);
    this.globalAi.push(now);
    this.running += 1;
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (!released) {
          released = true;
          this.running -= 1;
        }
      },
    };
  }
}

/**
 * The client a request comes from. Behind a trusted proxy (for example the host's edge) the first hop of
 * `x-forwarded-for` or `x-real-ip` is the visitor; with no proxy header every request shares one "local" bucket, which
 * is safe (it limits more, never less). A deployment not behind a trusted proxy must not rely on these headers.
 */
export function clientKeyOf(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const raw = forwarded || headers.get("x-real-ip")?.trim() || "local";
  return raw.slice(0, 64);
}
