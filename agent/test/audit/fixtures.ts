// FIXTURE-ONLY: synthetic GoPlus-shaped responses and LP evidence. Not live API output.
import type { AuditAsset, AuditPolicy } from "../../src/audit/decision.js";
import type { RawGoPlusResponse } from "../../src/audit/goplus.js";
import type { LpEvidence } from "../../src/audit/liquidity.js";

export const TOKEN = "0x00000000000000000000000000000000000000aa";
export const CHAIN = "46630";
export const NOW = new Date("2026-11-07T12:00:00.000Z");
export const QUERIED = "2026-11-07T11:59:00.000Z";

export const asset: AuditAsset = {
  chainId: CHAIN,
  token: TOKEN,
  representation: "aa.token.testnet",
  custodyDomain: "vault-1",
  mappingVersion: "m1",
};

export const CLEAN_ENTRY: Record<string, string> = {
  is_honeypot: "0",
  cannot_sell_all: "0",
  cannot_buy: "0",
  buy_tax: "0",
  sell_tax: "0",
  transfer_tax: "0",
  slippage_modifiable: "0",
  personal_slippage_modifiable: "0",
  transfer_pausable: "0",
  owner_change_balance: "0",
  is_blacklisted: "0",
  is_whitelisted: "0",
  is_mintable: "0",
  is_open_source: "1",
  is_proxy: "0",
  owner_address: "",
  hidden_owner: "0",
  can_take_back_ownership: "0",
  is_in_dex: "1",
};

export function goplus(
  overrides: Record<string, string | undefined> = {},
  opts: { key?: string; chainId?: string; code?: number; result?: unknown; httpStatus?: number } = {},
): RawGoPlusResponse {
  const entry: Record<string, string> = { ...CLEAN_ENTRY };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete entry[k];
    else entry[k] = v;
  }
  const body = {
    code: opts.code ?? 1,
    message: "OK",
    result: opts.result !== undefined ? opts.result : { [opts.key ?? TOKEN]: entry },
  };
  return {
    query: { chainId: opts.chainId ?? CHAIN, token: TOKEN },
    providerVersion: "token_security/v1",
    queriedAt: QUERIED,
    httpStatus: opts.httpStatus ?? 200,
    rawText: JSON.stringify(body),
    body,
  };
}

export function lp(usd: string, extra: Partial<LpEvidence["pools"][number]> = {}): LpEvidence {
  return {
    chainId: CHAIN,
    token: TOKEN,
    pools: [
      {
        chainId: CHAIN,
        poolId: "0xpool1",
        token: TOKEN,
        quoteAsset: "WETH",
        kind: "constant_product",
        headlineUsd: usd,
        valuationSource: "fixture-oracle",
        observedAt: QUERIED,
        observedBlock: "100",
        ...extra,
      },
    ],
  };
}

/** Fixture policy that resolves the OPEN decisions only so the Pass path can be exercised. NOT a real policy. */
export const FIXTURE_RESOLVED: AuditPolicy = {
  version: "fixture-policy",
  tax: {
    status: "resolved",
    id: "fixture-tax",
    evaluate: (tax) =>
      Object.values(tax).every((t) => t.kind === "known" && t.fraction === "0") ? "accept" : "pending",
  },
  admin: {
    status: "resolved",
    id: "fixture-admin",
    evaluate: (p) => (Object.values(p).every((f) => f.state === "false") ? "accept" : "pending"),
  },
  freshness: { status: "resolved", id: "fixture-fresh", ttlMs: 10 * 60_000 },
};
