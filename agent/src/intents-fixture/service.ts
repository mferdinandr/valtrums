import { type Logger, silentLogger } from "../logger.js";
import { sha256Hex } from "../mcp/actions/canonical.js";
import { FIXTURE_ASSETS, type FixtureAsset, RECORDED_QUOTE_AMOUNT_IN, assetByFixtureId } from "./assets.js";
import type { CustodyReceipt } from "./custody.js";
import { FIXTURE_HEADER, FIXTURE_LABEL, FIXTURE_ROUTE, assertFixtureAllowed } from "./label.js";
import type { FakeSolver } from "./solver.js";

/**
 * FIXTURE of the NEAR Intents 1Click API (D29): the same paths and JSON shapes for token
 * discovery, quote (dry and committed), deposit submission and execution status. Field names come
 * from the official OpenAPI (https://1click.chaindefuser.com/docs/v0/openapi.yaml) and the recorded
 * mainnet responses. It is a fixture: the settlement behind it is `FakeSolver`, and every quote and
 * status body carries `valtrumFixture` (an extra key the real API does not have) plus the
 * `x-valtrum-fixture` header, so it can never be mistaken for a real response.
 */

export interface FixtureRequest {
  method: string;
  /** Path with optional query string, e.g. `/v0/status?depositAddress=...`. */
  url: string;
  body?: unknown;
}
export interface FixtureResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export type OneClickStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "PROCESSING" | "SUCCESS" | "INCOMPLETE_DEPOSIT" | "REFUNDED" | "FAILED";
export const TERMINAL_STATUSES: readonly OneClickStatus[] = ["SUCCESS", "INCOMPLETE_DEPOSIT", "REFUNDED", "FAILED"];

interface StoredQuote {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: Record<string, unknown>;
  quote: Record<string, unknown>;
  depositAddress: string;
  origin: FixtureAsset;
  destination: FixtureAsset;
  amountIn: bigint;
  amountOut: bigint;
  status: OneClickStatus;
  updatedAtMs: number;
  originTx: string | null;
  receipt: CustodyReceipt | null;
  refundReason: string | null;
  failReason: string | null;
}

export interface FixtureServiceOptions {
  solver: FakeSolver;
  /** Configuration network; anything but testnet refuses to construct the service. */
  network: string;
  now?: () => number;
  logger?: Logger;
}

const NEAR_ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const DIGITS = /^[1-9][0-9]{0,38}$/;
const BURN = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);
const DEFAULT_SLIPPAGE_BPS = 100;
const QUOTE_TTL_MS = 10 * 60_000;

/** Decimal string of `value` with `decimals` places, trailing zeros trimmed (keeps one digit after the point). */
export function formatUnits(value: bigint, decimals: number): string {
  const s = value.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${whole}.${frac || "0"}`;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class IntentsFixtureService {
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly quotes = new Map<string, StoredQuote>();
  private seq = 0;

  constructor(private readonly opts: FixtureServiceOptions) {
    assertFixtureAllowed(opts.network);
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger ?? silentLogger;
  }

  /** The stored quote for a deposit address (test and trace inspection). */
  quoteFor(depositAddress: string): StoredQuote | undefined {
    return this.quotes.get(depositAddress);
  }

  handle(req: FixtureRequest): FixtureResponse {
    const [path, query = ""] = req.url.split("?", 2) as [string, string?];
    let res: FixtureResponse;
    try {
      res = this.route(req.method.toUpperCase(), path, new URLSearchParams(query), req.body);
    } catch (err) {
      if (err instanceof HttpError) res = this.respond(err.status, { message: err.message });
      else throw err;
    }
    this.logger.info("intents-fixture request", { fixture: true, route: FIXTURE_ROUTE, label: FIXTURE_LABEL, method: req.method, path, status: res.status });
    return res;
  }

  private respond(status: number, body: unknown): FixtureResponse {
    return { status, body, headers: { [FIXTURE_HEADER]: "true", "content-type": "application/json" } };
  }

  private route(method: string, path: string, query: URLSearchParams, body: unknown): FixtureResponse {
    if (method === "GET" && path === "/v0/tokens") return this.respond(200, this.tokens());
    if (method === "POST" && path === "/v0/quote") return this.respond(200, this.quote(body));
    if (method === "POST" && path === "/v0/deposit/submit") return this.respond(200, this.submit(body));
    if (method === "GET" && path === "/v0/status") return this.respond(200, this.statusOf(query));
    throw new HttpError(404, `${method} ${path} is not part of the fixture`);
  }

  /** `GET /v0/tokens`: an array of TokenResponse. */
  tokens(): Record<string, unknown>[] {
    const at = new Date(this.now()).toISOString();
    return FIXTURE_ASSETS.map((a) => ({
      assetId: a.fixtureAssetId,
      decimals: a.decimals,
      blockchain: a.blockchain,
      symbol: a.symbol,
      price: a.price,
      priceUpdatedAt: at,
      ...(a.contractAddress ? { contractAddress: a.contractAddress } : {}),
    }));
  }

  private quote(raw: unknown): Record<string, unknown> {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new HttpError(400, "request body must be an object");
    if (typeof r.dry !== "boolean") throw new HttpError(400, "dry must be a boolean");
    if (r.swapType !== "EXACT_INPUT") throw new HttpError(400, "the fixture supports swapType EXACT_INPUT only");
    for (const k of ["depositType", "refundType"] as const) {
      if (r[k] !== undefined && r[k] !== "ORIGIN_CHAIN") throw new HttpError(400, `the fixture supports ${k} ORIGIN_CHAIN only`);
    }
    if (r.recipientType !== undefined && r.recipientType !== "DESTINATION_CHAIN") throw new HttpError(400, "the fixture supports recipientType DESTINATION_CHAIN only");
    const origin = typeof r.originAsset === "string" ? assetByFixtureId(r.originAsset) : undefined;
    const destination = typeof r.destinationAsset === "string" ? assetByFixtureId(r.destinationAsset) : undefined;
    if (!origin) throw new HttpError(400, "originAsset is not a listed asset");
    if (!destination) throw new HttpError(400, "destinationAsset is not a listed asset");
    if (typeof r.amount !== "string" || !DIGITS.test(r.amount)) throw new HttpError(400, "amount must be a positive integer string");
    const slippage = r.slippageTolerance === undefined ? DEFAULT_SLIPPAGE_BPS : r.slippageTolerance;
    if (typeof slippage !== "number" || !Number.isInteger(slippage) || slippage < 0 || slippage > 5000) throw new HttpError(400, "slippageTolerance must be an integer between 0 and 5000 basis points");
    if (typeof r.recipient !== "string") throw new HttpError(400, "recipient is required");
    if (typeof r.refundTo !== "string") throw new HttpError(400, "refundTo is required");
    this.validateAddress(r.recipient, destination.blockchain, "recipient");
    this.validateAddress(r.refundTo, origin.blockchain, "refundTo");
    // The fixture routes the origin USDC mock to a destination that has a recorded price.
    if (origin.symbol !== "USDC" || !destination.recordedQuote) throw new HttpError(400, "no route is available for this asset pair");

    const amountIn = BigInt(r.amount);
    const amountOut = (amountIn * BigInt(destination.recordedQuote.amountOut)) / RECORDED_QUOTE_AMOUNT_IN;
    const minAmountOut = (amountOut * BigInt(10_000 - slippage)) / 10_000n;
    if (amountOut <= 0n || minAmountOut <= 0n) throw new HttpError(400, "amount is too small to quote");
    const nowMs = this.now();
    const deadlineMs = typeof r.deadline === "string" && Number.isFinite(Date.parse(r.deadline)) ? Date.parse(r.deadline) : nowMs + QUOTE_TTL_MS;
    const seq = ++this.seq;
    const correlationId = `fixture-${sha256Hex(`corr:${seq}:${nowMs}`).slice(0, 24)}`;
    const usd = formatUnits(amountIn, origin.decimals);
    const quoteRequest = {
      dry: r.dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: slippage,
      originAsset: origin.fixtureAssetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: destination.fixtureAssetId,
      amount: r.amount,
      refundTo: r.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: r.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(deadlineMs).toISOString(),
      depositMode: "SIMPLE",
    };
    const depositAddress = sha256Hex(`fixture-deposit:${seq}:${correlationId}`);
    const quote: Record<string, unknown> = {
      ...(r.dry ? {} : { depositAddress }),
      amountIn: r.amount,
      amountInFormatted: usd,
      amountInUsd: usd,
      minAmountIn: r.amount,
      amountOut: amountOut.toString(),
      amountOutFormatted: formatUnits(amountOut, destination.decimals),
      amountOutUsd: usd,
      minAmountOut: minAmountOut.toString(),
      ...(r.dry ? {} : { deadline: new Date(deadlineMs).toISOString(), timeWhenInactive: new Date(deadlineMs).toISOString() }),
      timeEstimate: destination.recordedQuote.timeEstimate,
    };
    const response = {
      correlationId,
      timestamp: new Date(nowMs).toISOString(),
      signature: `fixture-signature:${sha256Hex(`sig:${correlationId}`).slice(0, 32)}`,
      quoteRequest,
      quote,
      valtrumFixture: FIXTURE_LABEL,
    };
    if (!r.dry) {
      this.quotes.set(depositAddress, {
        correlationId,
        timestamp: response.timestamp,
        signature: response.signature,
        quoteRequest,
        quote,
        depositAddress,
        origin,
        destination,
        amountIn,
        amountOut,
        status: "PENDING_DEPOSIT",
        updatedAtMs: nowMs,
        originTx: null,
        receipt: null,
        refundReason: null,
        failReason: null,
      });
    }
    return response;
  }

  private validateAddress(value: string, chain: FixtureAsset["blockchain"], field: string): void {
    const ok = chain === "hood" ? EVM.test(value) && !BURN.has(value.toLowerCase()) : NEAR_ACCOUNT.test(value);
    if (!ok) throw new HttpError(400, `${field} is not valid`);
  }

  private find(depositAddress: unknown): StoredQuote {
    const q = typeof depositAddress === "string" ? this.quotes.get(depositAddress) : undefined;
    if (!q) throw new HttpError(404, "no quote exists for this deposit address");
    return q;
  }

  private submit(raw: unknown): Record<string, unknown> {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || typeof r.txHash !== "string" || !r.txHash) throw new HttpError(400, "txHash is required");
    const q = this.find(r.depositAddress);
    if (q.status === "PENDING_DEPOSIT") {
      q.originTx = r.txHash;
      this.setStatus(q, "KNOWN_DEPOSIT_TX");
    }
    return this.statusBody(q);
  }

  private statusOf(query: URLSearchParams): Record<string, unknown> {
    const q = this.find(query.get("depositAddress"));
    // Each poll after a submitted deposit advances one step; terminal states never change, so a
    // repeated poll cannot settle (or credit) a quote twice.
    if (q.status === "KNOWN_DEPOSIT_TX") this.setStatus(q, "PROCESSING");
    else if (q.status === "PROCESSING") this.settle(q);
    return this.statusBody(q);
  }

  private settle(q: StoredQuote): void {
    const outcome = this.opts.solver.settle({
      depositAddress: q.depositAddress,
      originAssetId: q.origin.fixtureAssetId,
      destinationAssetId: q.destination.fixtureAssetId,
      recipient: String(q.quoteRequest.recipient),
      refundTo: String(q.quoteRequest.refundTo),
      amountIn: q.amountIn,
      amountOut: q.amountOut,
    });
    if (outcome.status === "FAILED") q.failReason = outcome.reason;
    else q.receipt = outcome.receipt;
    if (outcome.status === "REFUNDED") q.refundReason = outcome.reason;
    this.setStatus(q, outcome.status);
  }

  private setStatus(q: StoredQuote, status: OneClickStatus): void {
    q.status = status;
    q.updatedAtMs = this.now();
    this.logger.info("intents-fixture status", { fixture: true, route: FIXTURE_ROUTE, label: FIXTURE_LABEL, depositAddress: q.depositAddress, status });
  }

  private statusBody(q: StoredQuote): Record<string, unknown> {
    const tx = (hash: string) => ({ hash, explorerUrl: `https://fixture.invalid/tx/${hash}` });
    const receipt = q.receipt;
    const delivered = q.status === "SUCCESS" && receipt ? receipt : null;
    const refunded = q.status === "REFUNDED" && receipt ? receipt : null;
    const deposited = q.status !== "PENDING_DEPOSIT";
    return {
      correlationId: q.correlationId,
      quoteResponse: { correlationId: q.correlationId, timestamp: q.timestamp, signature: q.signature, quoteRequest: q.quoteRequest, quote: q.quote },
      status: q.status,
      updatedAt: new Date(q.updatedAtMs).toISOString(),
      swapDetails: {
        intentHashes: [],
        nearTxHashes: [],
        originChainTxHashes: q.originTx ? [tx(q.originTx)] : [],
        destinationChainTxHashes: delivered ? [tx(delivered.transactionHash)] : [],
        ...(deposited ? { depositedAmount: q.amountIn.toString() } : {}),
        ...(delivered
          ? { amountIn: q.amountIn.toString(), amountOut: delivered.amount, amountOutFormatted: formatUnits(BigInt(delivered.amount), q.destination.decimals), slippage: Number(q.quoteRequest.slippageTolerance) }
          : {}),
        ...(refunded ? { refundedAmount: refunded.amount, refundReason: q.refundReason ?? "refunded" } : {}),
      },
      valtrumFixture: FIXTURE_LABEL,
    };
  }
}
