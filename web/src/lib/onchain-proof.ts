/**
 * On-chain activity of one battle: every transaction that created, joined, funded,
 * locked, scored, settled, voted on or paid out the battle, each with its hash.
 *
 * The contract stores state, not transaction hashes, so the hashes come from the
 * public FastNEAR transaction indexer: we list the arena's transactions in the
 * battle's time window (read from the contract) and keep the ones whose arguments
 * name this battle. Claims go to the community token contracts and carry only an
 * amount, so they are matched by token and time after the winners' vote.
 */

type Json = Record<string, unknown>;

export type ActivityKind =
  | "create"
  | "join"
  | "deposit"
  | "audit"
  | "backing"
  | "lock"
  | "round"
  | "prices"
  | "settle"
  | "escrow"
  | "vote"
  | "execute"
  | "claim"
  | "other";

export type ActivityItem = {
  hash: string;
  timeMs: number;
  kind: ActivityKind;
  label: string;
  signer: string;
};

export type BattleActivity = {
  battleId: number;
  winner: string | null;
  items: ActivityItem[];
};

export type Rpc = (method: string, params: unknown) => Promise<unknown>;
export type Post = (url: string, body: unknown) => Promise<unknown>;

const HOUR_NS = 3_600n * 1_000_000_000n;
/** Time before kickoff searched for the create, join and deposit transactions. */
const BEFORE_START_NS = 2n * HOUR_NS;
/** Time after the vote closes searched for execution and claims. */
const AFTER_CLOSE_NS = 1n * HOUR_NS;
const MAX_PAGES = 12;

/** `backing-degen.valtrum-owner-b694.testnet` → `DEGEN`. */
export function symbolOf(token: string): string {
  const head = token.split(".")[0] ?? token;
  return (head.startsWith("backing-") ? head.slice("backing-".length) : head).toUpperCase();
}

/** Raw units with decimals → "12.49"; without decimals the raw value stays exact. */
export function formatAmount(raw: string, decimals: number | null): string {
  if (decimals === null || !/^\d+$/.test(raw)) return raw;
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 2);
  return `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

const sameBattle = (v: unknown, id: number) => v !== undefined && v !== null && String(v) === String(id);

function parseJson(text: string): Json | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as Json) : null;
  } catch {
    return null;
  }
}

export type CallInput = {
  method: string;
  args: Json | null;
  receiver: string;
  /** Token symbols by community index, for joins and deposits that name an index. */
  symbols: string[];
  decimals: (token: string) => number | null;
  winner: string | null;
  startAtMs: string | null;
};

/** The step a function call performs for battle `battleId`, or null when it is about another battle. */
export function classify(battleId: number, c: CallInput): { kind: ActivityKind; label: string } | null {
  const a = c.args ?? {};
  const amount = (raw: unknown, token: string) => `${formatAmount(String(raw ?? ""), c.decimals(token))} ${symbolOf(token)}`;
  if (c.method === "ft_transfer_call") {
    const msg = parseJson(String(a.msg ?? ""));
    if (!msg) return null;
    if (msg.action === "lifecycle_create" && c.startAtMs && String(msg.start_at_ms) === c.startAtMs)
      return { kind: "create", label: `Battle created · ${amount(a.amount, c.receiver)} first deposit` };
    if (msg.action === "lifecycle_deposit" && sameBattle(msg.battle_id, battleId))
      return { kind: "deposit", label: `Deposited ${amount(a.amount, c.receiver)}` };
    return null;
  }
  if (c.method === "claim_entitlement_as_representation") return { kind: "claim", label: `Claimed ${amount(a.amount, c.receiver)}` };
  if (!sameBattle(a.battle_id, battleId)) return null;
  const tokenOf = (x: unknown) => (typeof x === "string" ? symbolOf(x) : null);
  const assetSymbol = tokenOf((a.asset as Json | undefined)?.representation) ?? tokenOf(a.representation);
  const indexSymbol = typeof a.community === "number" ? c.symbols[a.community] ?? null : null;
  switch (c.method) {
    case "join_lifecycle_battle":
      return { kind: "join", label: `${assetSymbol ?? "A crew"} joined the battle` };
    case "register_lifecycle_position":
      return { kind: "join", label: `Backer registered for ${indexSymbol ?? "a crew"}` };
    case "submit_lifecycle_audit":
      return { kind: "audit", label: `Safety check passed · ${assetSymbol ?? indexSymbol ?? "token"}` };
    case "refresh_lifecycle_backing":
      return { kind: "backing", label: `Backing verified · ${indexSymbol ?? assetSymbol ?? "token"}` };
    case "lock_lifecycle_battle":
      return { kind: "lock", label: "Battle locked, deposits closed" };
    case "start_lifecycle_rounds":
    case "open_lifecycle_round":
      return { kind: "round", label: `Round ${String(a.round_id ?? 1)} started` };
    case "submit_lifecycle_observations":
      return { kind: "prices", label: "Live prices recorded on-chain" };
    case "settle_lifecycle_battle":
      return { kind: "settle", label: `Battle settled${c.winner ? ` · ${c.winner} wins` : ""}` };
    case "reserve_lifecycle_escrow":
      return { kind: "escrow", label: "Winning deposit moved to DAO escrow" };
    case "vote_lifecycle_disposition":
      return { kind: "vote", label: `Winners' vote · burn ${String(a.burn_percent ?? "?")}%` };
    case "execute_lifecycle_disposition":
      return { kind: "execute", label: "Vote executed · burn and return released" };
    default:
      return { kind: "other", label: c.method.replace(/_/g, " ") };
  }
}

function decodeBase64(b64: string): string {
  try {
    const bin = atob(b64);
    return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  } catch {
    return "";
  }
}

/** Retries a request on network errors and 429/5xx, with a short backoff. */
export async function withRetry<T>(run: () => Promise<T>, attempts = 3, delayMs = 600): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await run();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}

export function makeRpc(rpcUrl: string, fetchImpl: typeof fetch = fetch): Rpc {
  return (method, params) => withRetry(async () => {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "activity", method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? "RPC error");
    return body.result;
  });
}

export function makePost(fetchImpl: typeof fetch = fetch): Post {
  return (url, body) => withRetry(async () => {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Indexer ${res.status}`);
    return res.json();
  });
}

async function view<T>(rpc: Rpc, contract: string, method: string, args: unknown): Promise<T> {
  const r = (await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  })) as { result?: number[] };
  if (!r.result) throw new Error(`${method}: empty result`);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))) as T;
}

type BlockHeader = { header: { height: number; timestamp: number | string } };

/** Block height at time `tNs`, estimated from the head and refined twice. */
async function heightAt(rpc: Rpc, tNs: bigint): Promise<number> {
  const head = (await rpc("block", { finality: "final" })) as BlockHeader;
  let h = head.header.height - Number((BigInt(head.header.timestamp) - tNs) / 1_000_000_000n);
  for (let i = 0; i < 2; i++) {
    try {
      const b = (await rpc("block", { block_id: h })) as BlockHeader;
      h = b.header.height - Math.round(Number(BigInt(b.header.timestamp) - tNs) / 1.05e9);
    } catch {
      h -= 1; // A missing (skipped) block: step and try again.
    }
  }
  return Math.max(1, h);
}

type AccountTx = { transaction_hash: string; tx_block_height: number; tx_block_timestamp: string };

/** Transactions touching `account` with timestamps in [loNs, hiNs], newest first. */
async function accountTxs(post: Post, indexer: string, account: string, maxHeight: number, loNs: bigint, hiNs: bigint): Promise<AccountTx[]> {
  const out: AccountTx[] = [];
  let max = maxHeight;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = (await post(`${indexer}/v0/account`, { account_id: account, max_block_height: max })) as { account_txs?: AccountTx[] };
    const txs = r.account_txs ?? [];
    if (txs.length === 0) return out;
    for (const t of txs) {
      const ts = BigInt(t.tx_block_timestamp);
      if (ts < loNs) return out;
      if (ts <= hiNs) out.push(t);
    }
    max = txs[txs.length - 1]!.tx_block_height - 1;
  }
  return out;
}

type IndexedTx = {
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: unknown[] };
};

async function txDetails(post: Post, indexer: string, hashes: string[]): Promise<IndexedTx[]> {
  const out: IndexedTx[] = [];
  for (let i = 0; i < hashes.length; i += 20) {
    const r = (await post(`${indexer}/v0/transactions`, { tx_hashes: hashes.slice(i, i + 20) })) as { transactions?: IndexedTx[] };
    out.push(...(r.transactions ?? []));
  }
  return out;
}

type LifecycleView = { start_at_ms?: string | null; communities: { representation: string }[] } | null;
type RoundView = { winner: number | null } | null;
type DispositionView = { closes_at_ns: string } | null;

export async function loadBattleActivity(opts: {
  rpc: Rpc;
  post: Post;
  indexer: string;
  contract: string;
  battleId: number;
  nowMs?: number;
}): Promise<BattleActivity> {
  const { rpc, post, indexer, contract, battleId } = opts;
  const battle = await view<LifecycleView>(rpc, contract, "get_lifecycle_battle", { battle_id: battleId });
  if (!battle) throw new Error(`Battle #${battleId} is not on the contract`);
  const [round, dao] = await Promise.all([
    view<RoundView>(rpc, contract, "get_lifecycle_round", { battle_id: String(battleId) }).catch(() => null),
    view<DispositionView>(rpc, contract, "get_lifecycle_disposition", { battle_id: String(battleId) }).catch(() => null),
  ]);
  const tokens = battle.communities.map((c) => c.representation);
  const symbols = tokens.map(symbolOf);
  const winner = round?.winner !== null && round?.winner !== undefined ? symbols[round.winner] ?? null : null;
  const decimalsList = await Promise.all(
    tokens.map((t) => view<{ decimals: number }>(rpc, t, "ft_metadata", {}).then((m) => m.decimals).catch(() => null)),
  );
  const decimals = (token: string) => decimalsList[tokens.indexOf(token)] ?? null;

  const nowNs = BigInt(opts.nowMs ?? Date.now()) * 1_000_000n;
  const startNs = battle.start_at_ms ? BigInt(battle.start_at_ms) * 1_000_000n : nowNs;
  const closeNs = dao ? BigInt(dao.closes_at_ns) : null;
  const loNs = startNs - BEFORE_START_NS;
  const hiNs = closeNs !== null ? (closeNs + AFTER_CLOSE_NS < nowNs ? closeNs + AFTER_CLOSE_NS : nowNs) : nowNs;
  const maxHeight = await heightAt(rpc, hiNs);

  // Arena transactions, plus claims on the battle's token contracts after the vote closed.
  const lists = await Promise.all([
    accountTxs(post, indexer, contract, maxHeight, loNs, hiNs),
    ...(closeNs !== null ? tokens.map((t) => accountTxs(post, indexer, t, maxHeight, closeNs, hiNs)) : []),
  ]);
  const timeOf = new Map<string, number>();
  for (const t of lists.flat()) timeOf.set(t.transaction_hash, Number(BigInt(t.tx_block_timestamp) / 1_000_000n));

  const items: ActivityItem[] = [];
  for (const tx of await txDetails(post, indexer, [...timeOf.keys()])) {
    const t = tx.transaction;
    for (const action of t.actions) {
      const fc = (action as { FunctionCall?: { method_name: string; args: string } }).FunctionCall;
      if (!fc) continue;
      const step = classify(battleId, {
        method: fc.method_name,
        args: parseJson(decodeBase64(fc.args)),
        receiver: t.receiver_id,
        symbols,
        decimals,
        winner,
        startAtMs: battle.start_at_ms ?? null,
      });
      // A claim only counts on this battle's tokens.
      if (step && (step.kind !== "claim" || tokens.includes(t.receiver_id))) {
        items.push({ hash: t.hash, timeMs: timeOf.get(t.hash) ?? 0, signer: t.signer_id, ...step });
        break;
      }
    }
  }
  items.sort((x, y) => x.timeMs - y.timeMs);
  return { battleId, winner, items };
}
