import { Near, fromHotConnect } from "near-kit";
import type {
  AccountView,
  ArenaApi,
  BattleActionInput,
  BattleView,
  ConfigView,
  DepositFromBalanceInput,
  DepositInput,
  FundBalanceInput,
  LivePrices,
  PositionView,
  ProposeInput,
  SettlementStep,
  TokenMeta,
  WithdrawLiquidInput,
} from "./types";

type HotConnector = Parameters<typeof fromHotConnect>[0];

export interface NearArenaOptions {
  contractId: string;
  network: "testnet" | "mainnet";
  rpcUrl: string;
  /** Wallet connector used to sign change calls. Views work without it. */
  connector?: HotConnector;
}

const GAS_FT_CALL = "100 Tgas";
const GAS_CLAIM = "100 Tgas";
const GAS_BALANCE_DEPOSIT = "200 Tgas";
const ONE_YOCTO = "1 yocto";

export function createNearArenaApi(opts: NearArenaOptions): ArenaApi {
  const reader = new Near({ network: opts.network, rpcUrl: opts.rpcUrl });
  const writer = opts.connector
    ? new Near({ network: opts.network, rpcUrl: opts.rpcUrl, wallet: fromHotConnect(opts.connector) })
    : null;

  const viewAt = async <T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await reader.view<T>(contractId, method, args);
    if (result === undefined) throw new Error(`${contractId}.${method} returned no value`);
    return result;
  };
  const view = <T>(method: string, args: Record<string, unknown> = {}): Promise<T> =>
    viewAt<T>(opts.contractId, method, args);

  const signer = (): Near => {
    if (!writer) throw new Error("Connect a wallet first");
    return writer;
  };

  const metaCache = new Map<string, Promise<TokenMeta>>();
  let configCache: Promise<ConfigView> | null = null;
  const getConfig = (): Promise<ConfigView> => (configCache ??= view<ConfigView>("get_config"));

  const ftTransferCall = async (signerId: string, tokenId: string, amount: bigint, msg: unknown) => {
    await signer().call(
      tokenId,
      "ft_transfer_call",
      { receiver_id: opts.contractId, amount: amount.toString(), msg: JSON.stringify(msg) },
      { signerId, gas: GAS_FT_CALL, attachedDeposit: ONE_YOCTO },
    );
  };

  return {
    mode: "near",
    getConfig,
    async getBattleCount() {
      return Number(await view<string | number>("get_battle_count"));
    },
    getBattles: (fromIndex, limit) =>
      view<BattleView[]>("get_battles", { from_index: fromIndex.toString(), limit: limit.toString() }),
    getBattle: (battleId) => view<BattleView | null>("get_battle", { battle_id: battleId.toString() }),
    getPosition: (battleId, accountId) =>
      view<PositionView | null>("get_position", { battle_id: battleId.toString(), account_id: accountId }),
    getAccount: (accountId) => view<AccountView>("get_account", { account_id: accountId }),
    getLiquidBalance: async (accountId, tokenId) =>
      String(await view<string | number>("get_liquid_balance", { account_id: accountId, token_id: tokenId })),
    getSettlementPlan: (battleId) => view<SettlementStep[]>("get_settlement_plan", { battle_id: battleId.toString() }),

    getTokenMeta(tokenId) {
      let cached = metaCache.get(tokenId);
      if (!cached) {
        cached = viewAt<{ symbol: string; decimals: number }>(tokenId, "ft_metadata")
          .then((m) => ({ id: tokenId, symbol: m.symbol, decimals: m.decimals }));
        metaCache.set(tokenId, cached);
        cached.catch(() => metaCache.delete(tokenId));
      }
      return cached;
    },

    // The contract exposes no spot prices; a price source is outside this data layer.
    async getLivePrices(): Promise<LivePrices | null> {
      return null;
    },

    async proposeBattle(input: ProposeInput) {
      const cfg = await getConfig();
      await ftTransferCall(input.signerId, cfg.usdc, BigInt(cfg.bond), {
        action: "propose",
        token_a: input.tokenA,
        token_b: input.tokenB,
        duration_secs: input.durationSecs,
      });
    },

    async depositCoin(input: DepositInput) {
      await ftTransferCall(input.signerId, input.tokenId, input.amount, {
        action: "deposit",
        battle_id: input.battleId,
        side: input.side,
      });
    },

    async claim({ signerId, battleId }: BattleActionInput) {
      await signer().call(
        opts.contractId,
        "claim",
        { battle_id: battleId.toString() },
        { signerId, gas: GAS_CLAIM },
      );
    },

    async withdrawInitialDeposit({ signerId, battleId }: BattleActionInput) {
      await signer().call(
        opts.contractId,
        "withdraw_initial_deposit",
        { battle_id: battleId.toString() },
        { signerId, gas: GAS_CLAIM },
      );
    },

    async fundBalance({ signerId, amount }: FundBalanceInput) {
      const cfg = await getConfig();
      await ftTransferCall(signerId, cfg.usdc, amount, { action: "fund_balance" });
    },

    // No attached deposit: the only deposit path a function-call key can sign.
    async depositFromBalance({ signerId, battleId, side, totalUsdc, minTokenOut }: DepositFromBalanceInput) {
      await signer().call(
        opts.contractId,
        "deposit_from_balance",
        { battle_id: battleId, side, total_usdc: totalUsdc.toString(), min_token_out: minTokenOut.toString() },
        { signerId, gas: GAS_BALANCE_DEPOSIT },
      );
    },

    // Needs 1 yoctoNEAR, so the wallet asks for full-access approval.
    async withdrawLiquid({ signerId, token, amount }: WithdrawLiquidInput) {
      await signer().call(
        opts.contractId,
        "withdraw_liquid",
        { token, amount: amount.toString() },
        { signerId, gas: GAS_FT_CALL, attachedDeposit: ONE_YOCTO },
      );
    },
  };
}
