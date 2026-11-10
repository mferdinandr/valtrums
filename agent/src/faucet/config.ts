/** One representation token the faucet hands out. */
export interface FaucetToken {
  symbol: string;
  /** NEAR account of the NEP-141 representation (the backing contract). */
  representation: string;
  /** Base units per claim, as a decimal string. */
  amount: string;
}

export interface FaucetConfig {
  /** The dedicated faucet account that holds the backed representation. */
  account: string;
  tokens: FaucetToken[];
  cooldownMs: number;
  /** Most transfers across all accounts in one hour. */
  maxPerHour: number;
}

const ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;
const SYMBOL = /^[A-Za-z0-9]{1,16}$/;
const AMOUNT = /^[1-9][0-9]{0,38}$/;

const int = (v: unknown, def: number, min: number, max: number, what: string): number => {
  const n = v === undefined ? def : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what} must be an integer from ${min} to ${max}`);
  return n;
};

export function parseFaucetTokens(raw: unknown): FaucetToken[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("FAUCET_TOKENS must be a non-empty JSON list");
  const seen = new Set<string>();
  return raw.map((t, i) => {
    const x = (t ?? {}) as Record<string, unknown>;
    const at = `FAUCET_TOKENS[${i}]`;
    if (typeof x.symbol !== "string" || !SYMBOL.test(x.symbol)) throw new Error(`${at}.symbol must be 1 to 16 letters or digits`);
    if (typeof x.representation !== "string" || !ACCOUNT.test(x.representation)) throw new Error(`${at}.representation must be a NEAR account id`);
    if (typeof x.amount !== "string" || !AMOUNT.test(x.amount)) throw new Error(`${at}.amount must be a positive integer string in base units`);
    const key = x.symbol.toUpperCase();
    if (seen.has(key)) throw new Error(`${at} repeats symbol ${x.symbol}`);
    seen.add(key);
    return { symbol: x.symbol.toUpperCase(), representation: x.representation, amount: x.amount };
  });
}

/** Reads the faucet settings from the environment. Errors name variables, never values. */
export function loadFaucetConfig(env: Record<string, string | undefined>): FaucetConfig {
  const account = env.FAUCET_ACCOUNT_ID?.trim() ?? "";
  if (!ACCOUNT.test(account)) throw new Error("FAUCET_ACCOUNT_ID must be a NEAR account id");
  let tokens: unknown;
  try {
    tokens = JSON.parse(env.FAUCET_TOKENS ?? "");
  } catch {
    throw new Error("FAUCET_TOKENS must be valid JSON");
  }
  return {
    account,
    tokens: parseFaucetTokens(tokens),
    cooldownMs: int(env.FAUCET_COOLDOWN_HOURS, 24, 1, 24 * 30, "FAUCET_COOLDOWN_HOURS") * 3_600_000,
    maxPerHour: int(env.FAUCET_MAX_PER_HOUR, 120, 1, 10_000, "FAUCET_MAX_PER_HOUR"),
  };
}

export const isNearAccount = (v: unknown): v is string => typeof v === "string" && ACCOUNT.test(v);
