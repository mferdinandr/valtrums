/**
 * On-chain proof for a battle: the state is read straight from the arena contract
 * over NEAR RPC (view calls), together with the block it was read at, so anyone can
 * check it on an explorer or with `near view`. No indexer or app backend is involved.
 */

export type ViewResult<T> = { value: T; blockHeight: number; blockHash: string };

export type ProofCommunity = { index: number; token: string; symbol: string; vault: string; decimals: number | null };

export type BattleProof = {
  contract: string;
  battleId: number;
  mode: string;
  creator: string;
  locked: boolean;
  cancelled: boolean;
  communities: ProofCommunity[];
  winner: number | null;
  roundId: string | null;
  dao: { status: string; burn: string; return: string; released: number; total: number } | null;
  blockHeight: number;
  blockHash: string;
};

type Rpc = (method: string, params: unknown) => Promise<unknown>;

/** `backing-degen.valtrum-owner-b694.testnet` → `DEGEN`. */
export function symbolOf(token: string): string {
  const head = token.split(".")[0] ?? token;
  return (head.startsWith("backing-") ? head.slice("backing-".length) : head).toUpperCase();
}

/** Raw units with known decimals → "12.5"; without decimals the raw value stays exact. */
export function formatAmount(raw: string, decimals: number | null): string {
  if (decimals === null || !/^\d+$/.test(raw)) return raw;
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 4);
  return `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

/** Copy-paste command that reproduces the read with near-cli-rs. */
export function verifyCommand(contract: string, battleId: number, network: string): string {
  return `near contract call-function as-read-only ${contract} get_lifecycle_round json-args '{"battle_id":"${battleId}"}' network-config ${network} now`;
}

function decodeResult(raw: unknown): unknown {
  const bytes = Uint8Array.from(raw as number[]);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function makeRpc(rpcUrl: string, fetchImpl: typeof fetch = fetch): Rpc {
  return async (method, params) => {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "proof", method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? "RPC error");
    return body.result;
  };
}

export async function viewCall<T>(rpc: Rpc, contract: string, method: string, args: unknown): Promise<ViewResult<T>> {
  const argsBase64 = btoa(JSON.stringify(args));
  const r = (await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: argsBase64,
  })) as { result?: number[]; block_height: number; block_hash: string; error?: string };
  if (r.error || !r.result) throw new Error(r.error ?? `${method}: empty result`);
  return { value: decodeResult(r.result) as T, blockHeight: r.block_height, blockHash: r.block_hash };
}

type LifecycleView = {
  creator: string;
  mode: string;
  locked: boolean;
  cancelled: boolean;
  communities: { representation: string; vault: string }[];
} | null;
type RoundView = { round_id: string; winner: number | null } | null;
type DispositionView = {
  status: string;
  burn_total?: string | null;
  return_total?: string | null;
  burn_weight: string;
  return_weight: string;
  released: number;
  total_releases: number;
} | null;

export async function loadBattleProof(rpc: Rpc, contract: string, battleId: number): Promise<BattleProof> {
  const battle = await viewCall<LifecycleView>(rpc, contract, "get_lifecycle_battle", { battle_id: battleId });
  if (!battle.value) throw new Error(`Battle #${battleId} is not on the contract`);
  const [round, dao] = await Promise.all([
    viewCall<RoundView>(rpc, contract, "get_lifecycle_round", { battle_id: String(battleId) }).catch(() => null),
    viewCall<DispositionView>(rpc, contract, "get_lifecycle_disposition", { battle_id: String(battleId) }).catch(() => null),
  ]);
  const decimals = await Promise.all(
    battle.value.communities.map((c) =>
      viewCall<{ decimals: number }>(rpc, c.representation, "ft_metadata", {})
        .then((m) => m.value.decimals)
        .catch(() => null),
    ),
  );
  const d = dao?.value ?? null;
  return {
    contract,
    battleId,
    mode: battle.value.mode,
    creator: battle.value.creator,
    locked: battle.value.locked,
    cancelled: battle.value.cancelled,
    communities: battle.value.communities.map((c, index) => ({
      index,
      token: c.representation,
      symbol: symbolOf(c.representation),
      vault: c.vault,
      decimals: decimals[index] ?? null,
    })),
    winner: round?.value?.winner ?? null,
    roundId: round?.value?.round_id ?? null,
    dao: d
      ? {
          status: d.status,
          burn: d.burn_total ?? d.burn_weight,
          return: d.return_total ?? d.return_weight,
          released: d.released,
          total: d.total_releases,
        }
      : null,
    blockHeight: battle.blockHeight,
    blockHash: battle.blockHash,
  };
}
