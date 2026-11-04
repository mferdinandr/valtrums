import { CREDIT_TTL_NS, NS_PER_MS, coinToUsdc, pow10, toBigInt } from "../amounts";
import { previewWinnerPayout, vaultsInUsdc } from "./payout";
import type {
  AccountView,
  ArenaApi,
  BattleActionInput,
  BattleView,
  ConfigView,
  DepositInput,
  LivePrices,
  PositionView,
  ProposeInput,
  SettlementStep,
  Side,
  TokenMeta,
} from "./types";

export const MOCK_ACCOUNT = "demo.testnet";
export const MOCK_USDC_ID = "usdc.tkn.testnet";
const USDC_ID = MOCK_USDC_ID;
const BOND = 20_000_000n; // 20 USDC
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const TOKENS: Record<string, { symbol: string; decimals: number; price: bigint }> = {
  "pepe.tkn.testnet": { symbol: "PEPE", decimals: 18, price: 12n * 10n ** 12n }, // $0.000012
  "shib.tkn.testnet": { symbol: "SHIB", decimals: 18, price: 25n * 10n ** 12n },
  "floki.tkn.testnet": { symbol: "FLOKI", decimals: 9, price: 3n * 10n ** 14n },
  "mog.tkn.testnet": { symbol: "MOG", decimals: 18, price: 15n * 10n ** 11n },
  "wojak.tkn.testnet": { symbol: "WOJAK", decimals: 18, price: 8n * 10n ** 13n },
};

/** Price table (USD per whole coin, 1e18 scaled) so a mock swap quote stays consistent with the demo battles. */
export const MOCK_TOKENS = TOKENS;

export interface MockOptions {
  /** Clock in epoch milliseconds. Defaults to Date.now. */
  now?: () => number;
  /** Artificial latency per call, in ms. */
  latencyMs?: number;
}

const ns = (ms: number): bigint => BigInt(Math.round(ms)) * NS_PER_MS;
const coins = (whole: number, decimals: number): bigint => BigInt(whole) * pow10(decimals);

/** Deterministic pseudo-random integer in [0, mod). */
function hash(seed: number, mod: number): number {
  let x = (seed * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return x % mod;
}

export function createMockArenaApi(options: MockOptions = {}): ArenaApi {
  const now = options.now ?? Date.now;
  const latency = options.latencyMs ?? 0;
  const t0 = now();

  const wait = async (): Promise<void> => {
    if (latency > 0) await new Promise((r) => setTimeout(r, latency));
  };

  const mk = (
    id: number,
    a: string,
    b: string,
    status: BattleView["status"],
    startOffsetMs: number | null,
    vaultA: number,
    vaultB: number,
    extra: Partial<BattleView> = {},
  ): BattleView => {
    const ta = TOKENS[a]!;
    const tb = TOKENS[b]!;
    const start = startOffsetMs === null ? null : t0 + startOffsetMs;
    return {
      id,
      creator: id % 2 === 0 ? "alice.testnet" : "bob.testnet",
      token_a: a,
      token_b: b,
      bond: BOND.toString(),
      duration_ns: ns(DAY_MS).toString(),
      deposit_deadline_ns: ns(start === null ? t0 + 2 * DAY_MS : start).toString(),
      status,
      vault_a: coins(vaultA, ta.decimals).toString(),
      vault_b: coins(vaultB, tb.decimals).toString(),
      start_time_ns: start === null ? "0" : ns(start).toString(),
      end_time_ns: start === null ? "0" : ns(start + DAY_MS).toString(),
      initial_price_a: null,
      initial_price_b: null,
      final_price_a: null,
      final_price_b: null,
      winner: null,
      ...extra,
    };
  };

  const init = (a: string, b: string) => ({
    initial_price_a: TOKENS[a]!.price.toString(),
    initial_price_b: TOKENS[b]!.price.toString(),
  });

  const P = "pepe.tkn.testnet";
  const S = "shib.tkn.testnet";
  const F = "floki.tkn.testnet";
  const M = "mog.tkn.testnet";
  const W = "wojak.tkn.testnet";

  const battles: BattleView[] = [
    mk(1, P, S, "Proposed", null, 0, 0),
    // Deposits open for 6 more hours.
    mk(2, F, M, "Approved", 6 * HOUR_MS, 4_000_000, 2_500_000),
    // Live, 9 hours in.
    mk(3, M, W, "Live", -9 * HOUR_MS, 5_000_000_000, 120_000_000, init(M, W)),
    // Ended 20 minutes ago, waiting for the settlement plan to run.
    mk(4, S, F, "Settling", -DAY_MS - 20 * 60_000, 6_000_000, 3_000_000, init(S, F)),
    // Settled two days ago; side A won.
    mk(5, P, W, "Settled", -3 * DAY_MS, 500_000_000, 200_000_000, {
      ...init(P, W),
      final_price_a: ((TOKENS[P]!.price * 13n) / 10n).toString(),
      final_price_b: ((TOKENS[W]!.price * 9n) / 10n).toString(),
      winner: "A",
    }),
    mk(6, S, M, "EmergencyHalted", -5 * HOUR_MS, 3_000_000, 4_000_000, init(S, M)),
    mk(7, P, F, "Voided", null, 0, 0),
  ];

  const positions = new Map<string, PositionView>();
  const accounts = new Map<string, AccountView>();
  const key = (id: number, acct: string) => `${id}:${acct}`;

  const seedPosition = (id: number, acct: string, side: Side, amount: number) => {
    const b = battles.find((x) => x.id === id)!;
    const token = side === "A" ? b.token_a : b.token_b;
    const meta = TOKENS[token]!;
    const price = priceOf(token);
    const raw = coins(amount, meta.decimals);
    positions.set(key(id, MOCK_ACCOUNT), {
      side,
      coin_amount: raw.toString(),
      usdc_equiv: coinToUsdc(raw, meta.decimals, price).toString(),
      from_credit: "0",
      claimed: false,
    });
  };

  function priceOf(token: string): bigint {
    return TOKENS[token]!.price;
  }

  seedPosition(2, MOCK_ACCOUNT, "A", 800_000);
  seedPosition(3, MOCK_ACCOUNT, "B", 40_000_000);
  seedPosition(5, MOCK_ACCOUNT, "A", 100_000_000);
  seedPosition(6, MOCK_ACCOUNT, "A", 500_000);

  accounts.set(MOCK_ACCOUNT, {
    liquid_balance: (12_500_000n).toString(),
    credit_balance: (35_000_000n).toString(),
    credit_expires_at_ns: ns(t0 + 5 * DAY_MS + 3 * HOUR_MS).toString(),
  });

  const metaOf = (id: string): TokenMeta => {
    const t = TOKENS[id];
    return { id, symbol: t?.symbol ?? id.split(".")[0]!.toUpperCase(), decimals: t?.decimals ?? 18 };
  };

  const find = (id: number): BattleView => {
    const b = battles.find((x) => x.id === id);
    if (!b) throw new Error(`Battle ${id} not found`);
    return b;
  };

  const api: ArenaApi = {
    mode: "mock",

    async getConfig(): Promise<ConfigView> {
      await wait();
      return {
        owner: "owner.testnet",
        usdc: USDC_ID,
        treasury: "treasury.testnet",
        bond: BOND.toString(),
        agents: ["agent.testnet"],
        paused: false,
      };
    },

    async getBattleCount() {
      await wait();
      return battles.length;
    },

    async getBattles(fromIndex, limit) {
      await wait();
      return battles.slice(fromIndex, fromIndex + limit).map((b) => ({ ...b }));
    },

    async getBattle(id) {
      await wait();
      const b = battles.find((x) => x.id === id);
      return b ? { ...b } : null;
    },

    async getPosition(id, acct) {
      await wait();
      const p = positions.get(key(id, acct));
      return p ? { ...p } : null;
    },

    async getAccount(acct) {
      await wait();
      const a = accounts.get(acct);
      return a ? { ...a } : { liquid_balance: "0", credit_balance: "0", credit_expires_at_ns: "0" };
    },

    async getSettlementPlan(id): Promise<SettlementStep[]> {
      await wait();
      const b = find(id);
      if (b.status !== "Settling" && b.status !== "Settled") return [];
      const settled = b.status === "Settled";
      return [
        { index: 0, kind: "Dump", amount: b.vault_b, done: true, realized: "1200000" },
        { index: 1, kind: "Buy", amount: "1200000", done: true, realized: b.vault_a },
        { index: 2, kind: "Burn", amount: "60000", done: settled, realized: settled ? "60000" : null },
        { index: 3, kind: "Return", amount: b.vault_a, done: settled, realized: settled ? b.vault_a : null },
      ];
    },

    async getTokenMeta(id) {
      await wait();
      return metaOf(id);
    },

    async getLivePrices(id): Promise<LivePrices | null> {
      await wait();
      const b = find(id);
      if (b.status !== "Live" && b.status !== "Settling") return null;
      if (!b.initial_price_a || !b.initial_price_b) return null;
      const minute = Math.floor(now() / 60_000);
      const drift = (side: number) => BigInt(hash(id * 7 + side + minute, 4001) - 1500);
      return {
        a: (BigInt(b.initial_price_a) * (10_000n + drift(1))) / 10_000n,
        b: (BigInt(b.initial_price_b) * (10_000n + drift(2))) / 10_000n,
      };
    },

    async proposeBattle(input: ProposeInput) {
      await wait();
      if (input.tokenA === input.tokenB) throw new Error("Tokens must differ");
      const id = battles.length + 1;
      battles.push(
        mk(id, P, S, "Proposed", null, 0, 0, {
          creator: input.signerId,
          token_a: input.tokenA,
          token_b: input.tokenB,
          duration_ns: ns(input.durationSecs * 1000).toString(),
        }),
      );
    },

    async depositCoin(input: DepositInput) {
      await wait();
      const b = find(input.battleId);
      if (b.status !== "Approved") throw new Error("Deposits are closed");
      const token = input.side === "A" ? b.token_a : b.token_b;
      if (token !== input.tokenId) throw new Error("Wrong coin for this side");
      const k = key(b.id, input.signerId);
      const existing = positions.get(k);
      if (existing && existing.side !== input.side) throw new Error("Already on the other side");
      const meta = metaOf(token);
      const price = TOKENS[token]?.price ?? 10n ** 12n;
      const usdc = coinToUsdc(input.amount, meta.decimals, price);
      positions.set(k, {
        side: input.side,
        coin_amount: (toBigInt(existing?.coin_amount) + input.amount).toString(),
        usdc_equiv: (toBigInt(existing?.usdc_equiv) + usdc).toString(),
        from_credit: existing?.from_credit ?? "0",
        claimed: false,
      });
      if (input.side === "A") b.vault_a = (toBigInt(b.vault_a) + input.amount).toString();
      else b.vault_b = (toBigInt(b.vault_b) + input.amount).toString();
    },

    async claim({ signerId, battleId }: BattleActionInput) {
      await wait();
      const b = find(battleId);
      const pos = positions.get(key(battleId, signerId));
      if (b.status !== "Settled" || !pos) throw new Error("Nothing to claim");
      if (pos.claimed) throw new Error("Already claimed");
      if (pos.side !== b.winner) throw new Error("This side did not win");
      const prices = {
        a: BigInt(b.final_price_a!),
        b: BigInt(b.final_price_b!),
        source: "final" as const,
      };
      const preview = previewWinnerPayout(pos, vaultsInUsdc(b, metaOf(b.token_a), metaOf(b.token_b), prices));
      const acct = accounts.get(signerId) ?? { liquid_balance: "0", credit_balance: "0", credit_expires_at_ns: "0" };
      const live = toBigInt(acct.credit_expires_at_ns) > ns(now());
      accounts.set(signerId, {
        liquid_balance: (toBigInt(acct.liquid_balance) + preview.totalLiquid).toString(),
        credit_balance: ((live ? toBigInt(acct.credit_balance) : 0n) + preview.credit).toString(),
        credit_expires_at_ns: (ns(now()) + CREDIT_TTL_NS).toString(),
      });
      pos.claimed = true;
    },

    async withdrawInitialDeposit({ signerId, battleId }: BattleActionInput) {
      await wait();
      const b = find(battleId);
      const pos = positions.get(key(battleId, signerId));
      if ((b.status !== "EmergencyHalted" && b.status !== "Voided") || !pos) throw new Error("Nothing to refund");
      if (pos.claimed) throw new Error("Already refunded");
      pos.claimed = true;
    },
  };

  return api;
}
