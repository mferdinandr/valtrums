import type { ArenaClient } from "./client.js";
import {
  SEL_APPROVE,
  decodeUintWord,
  encodeAllowance,
  encodeApprove,
  encodeBalanceOf,
  encodeExactInputSingle,
  encodeTransfer,
  normalizeAddress,
} from "./evm-abi.js";
import { type EvmAddressResolver, battlePath } from "./evm-address.js";
import type { EvmQuoteSource } from "./evm-quote.js";
import { receivedAmount } from "./evm-receipt.js";
import type { EvmReceipt, EvmRpc } from "./evm-rpc.js";
import { type DecodedTx, decodeTx, txHash } from "./evm-tx.js";
import type { StepExecutor } from "./executor.js";
import { type Logger, errorMessage, silentLogger } from "./logger.js";
import type {
  BattleView,
  ForeignCall,
  ForeignConfigView,
  ForeignTxParams,
  SettlementStep,
  SignRequestView,
} from "./types.js";

/** Signing attempts the contract allows per request (`MAX_SIGN_ATTEMPTS`). */
export const MAX_SIGN_ATTEMPTS = 5;

export type ForeignErrorCode =
  | "reverted"
  | "signature_exhausted"
  | "signature_pending"
  | "not_confirmed"
  | "nonce_consumed"
  | "insufficient_funds"
  | "config";

/** A condition that stops the current battle; the next pass resumes from chain state. */
export class ForeignExecutionError extends Error {
  constructor(
    readonly code: ForeignErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ForeignExecutionError";
  }
}

export interface ForeignExecutorConfig {
  /** Expected EVM chain id; must equal the arena's foreign config and the RPC's chain. */
  chainId: bigint;
  /** USDC on the foreign chain. */
  usdc: string;
  /** NEAR token account id to EVM token address. */
  tokenMap: ReadonlyMap<string, string>;
  /** Uniswap V3 pool fee tier, in hundredths of a basis point (3000 = 0.3%). */
  feeTier: number;
  /** Blocks (counting the inclusion block) before a receipt is trusted. */
  confirmations: number;
  /** Polls waiting for a signature, and for a receipt, before giving up for this pass. */
  maxSignaturePolls?: number;
  maxReceiptPolls?: number;
  pollIntervalMs?: number;
  /** How many of the newest signature requests to scan when looking for a step's requests. */
  scanLimit?: number;
}

export interface ForeignExecutorDeps {
  client: ArenaClient;
  rpc: EvmRpc;
  resolver: EvmAddressResolver;
  quotes: EvmQuoteSource;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

interface StepSpec {
  /** Swap or transfer to sign. */
  call: ForeignCall;
  /** Contract the signed transaction must address. */
  to: string;
  /** Token whose receipt Transfer logs give the realized amount, and who must receive it. */
  proceedsToken: string;
  proceedsTo: string;
  /** Token spent (needs balance and, for swaps, router allowance), and how much. */
  spendToken: string;
  spendAmount: bigint;
  needsApproval: boolean;
}

type Request = { id: number; view: SignRequestView };

/**
 * Executes settlement steps on the foreign chain through the MPC signer. Each
 * call to `execute` derives its position from chain state only (the signature
 * requests of the battle and step, receipts, allowance), so a restart resumes
 * where the previous run stopped. It returns the realized amount from the
 * receipt; `driveSettlement` reports it, once, after this returns.
 *
 * Funds move on a real chain. A reverted transaction stops the battle with a
 * `ForeignExecutionError` and is never reported.
 */
export class ForeignChainStepExecutor implements StepExecutor {
  private readonly log: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cfg: Required<ForeignExecutorConfig>;
  private verifiedChain = false;

  constructor(
    cfg: ForeignExecutorConfig,
    private readonly deps: ForeignExecutorDeps,
  ) {
    this.log = deps.log ?? silentLogger;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.cfg = {
      maxSignaturePolls: 40,
      maxReceiptPolls: 60,
      pollIntervalMs: 5000,
      scanLimit: 500,
      ...cfg,
      usdc: normalizeAddress(cfg.usdc),
    };
    if (cfg.confirmations < 1) throw new Error("confirmations must be at least 1");
  }

  async execute(step: SettlementStep, battle: BattleView): Promise<bigint> {
    const { client, rpc, resolver } = this.deps;
    const fields = { battleId: battle.id, step: step.index, kind: step.kind };
    const foreign = await client.getForeignConfig();
    if (!foreign) throw new ForeignExecutionError("config", "the arena has no foreign-chain configuration");
    await this.verifyChain(foreign);
    const amount = BigInt(step.amount);
    if (amount === 0n) {
      this.log.info("zero-amount step, nothing to send", fields);
      return 0n;
    }
    const wallet = await resolver.resolve(battlePath(battle.id));
    const spec = this.specFor(step, battle, foreign, wallet);

    const existing = await this.requestsFor(battle.id, step.index);
    let request: Request;
    if (existing.length > 0) {
      request = existing[existing.length - 1] as Request;
      this.log.info("resuming step request", { ...fields, requestId: request.id, status: request.view.status });
    } else {
      await this.checkSpendable(wallet, spec);
      // Quote first: without a safe bound nothing is sent, not even the approval.
      const minOutCall = await this.withMinOut(spec);
      if (spec.needsApproval) await this.ensureAllowance(battle.id, wallet, foreign, spec);
      request = await this.createRequest(battle.id, step.index, wallet, minOutCall, spec.to);
      this.log.info("signature requested", { ...fields, requestId: request.id });
    }

    const receipt = await this.signBroadcastConfirm(request, spec, wallet, fields);
    const realized = receivedAmount(receipt, spec.proceedsToken, spec.proceedsTo);
    if (realized === 0n) {
      throw new ForeignExecutionError(
        "reverted",
        `transaction ${receipt.transactionHash} succeeded but delivered no tokens to ${spec.proceedsTo}`,
      );
    }
    this.log.info("step executed on the foreign chain", {
      ...fields,
      txHash: receipt.transactionHash,
      realized,
    });
    return realized;
  }

  // ─── step planning ────────────────────────────────────────────────────

  private evmToken(nearId: string): string {
    const addr = this.cfg.tokenMap.get(nearId);
    if (!addr) throw new ForeignExecutionError("config", `no EVM address mapped for token ${nearId}`);
    return addr;
  }

  private specFor(step: SettlementStep, battle: BattleView, foreign: ForeignConfigView, wallet: string): StepSpec {
    const amount = BigInt(step.amount);
    const router = normalizeAddress(foreign.router);
    const usdc = this.cfg.usdc;
    if (step.kind === "Return") {
      const treasury = normalizeAddress(foreign.treasury);
      return {
        call: { kind: "transfer", token: usdc, to: treasury, amount },
        to: usdc,
        proceedsToken: usdc,
        proceedsTo: treasury,
        spendToken: usdc,
        spendAmount: amount,
        needsApproval: false,
      };
    }
    if (battle.winner === null) {
      throw new ForeignExecutionError("config", `battle ${battle.id} has no winner, cannot pick swap tokens`);
    }
    const winnerCoin = this.evmToken(battle.winner === "A" ? battle.token_a : battle.token_b);
    const loserCoin = this.evmToken(battle.winner === "A" ? battle.token_b : battle.token_a);
    const [tokenIn, tokenOut] = step.kind === "Dump" ? [loserCoin, usdc] : [usdc, winnerCoin];
    const recipient = step.kind === "Burn" ? normalizeAddress(foreign.burn) : wallet;
    return {
      // min_out is filled in by withMinOut right before signing.
      call: {
        kind: "swap_exact_in",
        token_in: tokenIn,
        token_out: tokenOut,
        fee: this.cfg.feeTier,
        recipient,
        amount_in: amount,
        min_out: 0n,
      },
      to: router,
      proceedsToken: tokenOut,
      proceedsTo: recipient,
      spendToken: tokenIn,
      spendAmount: amount,
      needsApproval: true,
    };
  }

  private async withMinOut(spec: StepSpec): Promise<ForeignCall> {
    const call = spec.call;
    if (call.kind !== "swap_exact_in") return call;
    let minOut: bigint;
    try {
      minOut = await this.deps.quotes.minOut({
        tokenIn: call.token_in,
        tokenOut: call.token_out,
        fee: call.fee,
        amountIn: call.amount_in,
      });
    } catch (err) {
      throw new Error(`no safe swap quote, not signing: ${errorMessage(err)}`);
    }
    if (minOut <= 0n) throw new Error("no safe swap quote, not signing: minimum output is zero");
    return { ...call, min_out: minOut };
  }

  private async checkSpendable(wallet: string, spec: StepSpec): Promise<void> {
    const balance = decodeUintWord(
      await this.deps.rpc.call({ to: spec.spendToken, data: encodeBalanceOf(wallet) }),
    );
    if (balance < spec.spendAmount) {
      throw new ForeignExecutionError(
        "insufficient_funds",
        `${wallet} holds ${balance} of ${spec.spendToken} but the step needs ${spec.spendAmount}`,
      );
    }
  }

  // ─── approvals ────────────────────────────────────────────────────────

  private async readAllowance(wallet: string, token: string, spender: string): Promise<bigint> {
    return decodeUintWord(await this.deps.rpc.call({ to: token, data: encodeAllowance(wallet, spender) }));
  }

  /** Approves exactly the amount a step spends, unless the router already may spend that much. */
  private async ensureAllowance(
    battleId: number,
    wallet: string,
    foreign: ForeignConfigView,
    spec: StepSpec,
  ): Promise<void> {
    const router = normalizeAddress(foreign.router);
    const needed = spec.spendAmount;
    if ((await this.readAllowance(wallet, spec.spendToken, router)) >= needed) {
      this.log.info("allowance sufficient, no approval", { battleId, token: spec.spendToken });
      return;
    }
    const approve: StepSpec = {
      call: { kind: "approve", token: spec.spendToken, spender: router, amount: needed },
      to: spec.spendToken,
      proceedsToken: spec.spendToken,
      proceedsTo: wallet,
      spendToken: spec.spendToken,
      spendAmount: 0n,
      needsApproval: false,
    };
    const candidate = await this.usableApproval(battleId, wallet, spec.spendToken, router, needed);
    const request =
      candidate ?? (await this.createRequest(battleId, null, wallet, approve.call, spec.spendToken));
    this.log.info("approval", { battleId, requestId: request.id, resumed: candidate !== null });
    await this.signBroadcastConfirm(request, approve, wallet, { battleId, approvalFor: spec.spendToken });
    if ((await this.readAllowance(wallet, spec.spendToken, router)) < needed) {
      throw new ForeignExecutionError("reverted", "allowance is still insufficient after the approval");
    }
  }

  /** An earlier approval request of this battle that has not been mined and could still be sent. */
  private async usableApproval(
    battleId: number,
    wallet: string,
    token: string,
    router: string,
    needed: bigint,
  ): Promise<Request | null> {
    const pending = await this.deps.rpc.getTransactionCount(wallet, "pending");
    const all = await this.requestsFor(battleId, null);
    for (const r of [...all].reverse()) {
      const tx = decodeTx(r.view.signed_tx ?? r.view.unsigned_tx);
      const want = encodeApprove(router, needed).slice(0, 10 + 64);
      if (tx.to !== token || !tx.data.startsWith(SEL_APPROVE) || !tx.data.startsWith(want)) continue;
      if (BigInt(`0x${tx.data.slice(10 + 64)}`) < needed) continue;
      if (r.view.status === "Failed" && r.view.attempts >= MAX_SIGN_ATTEMPTS) continue;
      if (r.view.signed_tx && r.view.tx_hash) {
        const hash = `0x${r.view.tx_hash}`;
        if ((await this.deps.rpc.getTransactionReceipt(hash)) !== null) continue; // mined already
        if (await this.deps.rpc.isTransactionKnown(hash)) return r; // in the mempool
      }
      if (tx.nonce >= pending) return r;
    }
    return null;
  }

  // ─── requests ─────────────────────────────────────────────────────────

  /** Requests of a battle and step (null: no step), oldest first, from the newest `scanLimit` ids. */
  private async requestsFor(battleId: number, stepIndex: number | null): Promise<Request[]> {
    const count = await this.deps.client.getSignatureRequestCount();
    const out: Request[] = [];
    for (let id = count; id >= 1 && count - id < this.cfg.scanLimit; id--) {
      const view = await this.deps.client.getSignatureRequest(id);
      if (view && view.battle_id === battleId && view.step_index === stepIndex) out.unshift({ id, view });
    }
    return out;
  }

  private async createRequest(
    battleId: number,
    stepIndex: number | null,
    wallet: string,
    call: ForeignCall,
    to: string,
  ): Promise<Request> {
    const { rpc, client } = this.deps;
    const nonce = await rpc.getTransactionCount(wallet, "pending");
    const fees = await rpc.getFees();
    const data = callData(call);
    let estimate: bigint;
    try {
      estimate = await rpc.estimateGas({ from: wallet, to, data });
    } catch (err) {
      throw new Error(`gas estimation failed, not signing: ${errorMessage(err)}`);
    }
    const gasLimit = (estimate * 12n) / 10n;
    const needed = gasLimit * fees.maxFeePerGas;
    const balance = await rpc.getBalance(wallet);
    if (balance < needed) {
      throw new ForeignExecutionError(
        "insufficient_funds",
        `${wallet} needs about ${needed} wei for gas but holds ${balance}; fund it and the next pass continues`,
      );
    }
    const params: ForeignTxParams = {
      nonce,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      gasLimit,
    };
    const id = await client.requestSignature(battleId, call, params, stepIndex);
    const view = await client.getSignatureRequest(id);
    if (!view) throw new Error(`signature request ${id} not found after creating it`);
    return { id, view };
  }

  /** Wait for the signature (retrying failures), broadcast once, wait for confirmations. */
  private async signBroadcastConfirm(
    request: Request,
    spec: StepSpec,
    wallet: string,
    fields: Record<string, unknown>,
  ): Promise<EvmReceipt> {
    const signed = await this.awaitSignature(request);
    const tx = this.verifySigned(signed, spec);
    const hash = `0x${signed.tx_hash}`;
    const { rpc } = this.deps;

    let receipt = await rpc.getTransactionReceipt(hash);
    if (receipt === null && !(await rpc.isTransactionKnown(hash))) {
      const pending = await rpc.getTransactionCount(wallet, "pending");
      if (tx.nonce < pending) {
        throw new ForeignExecutionError(
          "nonce_consumed",
          `nonce ${tx.nonce} of ${wallet} was used by another transaction; request ${request.id} cannot be sent`,
        );
      }
      try {
        await rpc.sendRawTransaction(`0x${signed.signed_tx}`);
        this.log.info("transaction broadcast", { ...fields, txHash: hash });
      } catch (err) {
        // The node may have accepted it before failing: only a transaction it does not know is an error.
        if (!(await rpc.isTransactionKnown(hash))) throw err;
        this.log.warn("broadcast reported an error but the node knows the transaction", {
          ...fields,
          txHash: hash,
          error: errorMessage(err),
        });
      }
    }
    return this.awaitReceipt(hash);
  }

  private async awaitSignature(request: Request): Promise<SignRequestView> {
    const { client } = this.deps;
    let view = request.view;
    for (let poll = 0; ; poll++) {
      if (view.status === "Signed" && view.signed_tx && view.tx_hash) return view;
      if (view.status === "Failed") {
        if (view.attempts >= MAX_SIGN_ATTEMPTS) {
          throw new ForeignExecutionError(
            "signature_exhausted",
            `signature request ${request.id} failed ${view.attempts} times; manual attention needed`,
          );
        }
        this.log.warn("signature failed, retrying", { requestId: request.id, attempts: view.attempts });
        await client.retrySignature(request.id);
        poll = 0; // retries are bounded by the contract's attempt limit
      }
      if (poll >= this.cfg.maxSignaturePolls) {
        throw new ForeignExecutionError(
          "signature_pending",
          `signature request ${request.id} is still pending, will check again next pass`,
        );
      }
      await this.sleep(this.cfg.pollIntervalMs);
      const next = await client.getSignatureRequest(request.id);
      if (!next) throw new Error(`signature request ${request.id} disappeared`);
      view = next;
    }
  }

  /** The signed bytes must hash to the announced hash and do what this step expects. */
  private verifySigned(view: SignRequestView, spec: StepSpec): DecodedTx {
    const signedHex = view.signed_tx as string;
    if (txHash(signedHex) !== `0x${view.tx_hash}`.toLowerCase()) {
      throw new Error("signed transaction does not match its announced hash");
    }
    const tx = decodeTx(signedHex);
    if (!tx.signed) throw new Error("the stored transaction is not signed");
    if (tx.chainId !== this.cfg.chainId) throw new Error("signed transaction is for another chain");
    if (tx.to !== normalizeAddress(spec.to)) throw new Error("signed transaction addresses the wrong contract");
    if (tx.value !== 0n) throw new Error("signed transaction carries value");
    if (tx.data !== expectedData(spec.call, tx.data)) {
      throw new Error("signed transaction does not do what the step expects");
    }
    return tx;
  }

  private async awaitReceipt(hash: string): Promise<EvmReceipt> {
    const { rpc } = this.deps;
    for (let poll = 0; ; poll++) {
      const receipt = await rpc.getTransactionReceipt(hash);
      if (receipt) {
        if (!receipt.status) {
          throw new ForeignExecutionError("reverted", `transaction ${hash} reverted; the step was not reported`);
        }
        const head = await rpc.blockNumber();
        if (head - receipt.blockNumber + 1n >= BigInt(this.cfg.confirmations)) return receipt;
      }
      if (poll >= this.cfg.maxReceiptPolls) {
        throw new ForeignExecutionError(
          "not_confirmed",
          `transaction ${hash} is not confirmed yet, will check again next pass`,
        );
      }
      await this.sleep(this.cfg.pollIntervalMs);
    }
  }

  private async verifyChain(foreign: ForeignConfigView): Promise<void> {
    if (this.verifiedChain) return;
    if (BigInt(foreign.chain_id) !== this.cfg.chainId) {
      throw new ForeignExecutionError(
        "config",
        `arena chain id ${foreign.chain_id} differs from FOREIGN_CHAIN_ID ${this.cfg.chainId}`,
      );
    }
    const rpcChain = await this.deps.rpc.chainId();
    if (rpcChain !== this.cfg.chainId) {
      throw new ForeignExecutionError(
        "config",
        `the EVM RPC serves chain ${rpcChain}, expected ${this.cfg.chainId}`,
      );
    }
    this.verifiedChain = true;
  }
}

function callData(call: ForeignCall): string {
  switch (call.kind) {
    case "approve":
      return encodeApprove(call.spender, call.amount);
    case "transfer":
      return encodeTransfer(call.to, call.amount);
    case "swap_exact_in":
      return encodeExactInputSingle({
        tokenIn: call.token_in,
        tokenOut: call.token_out,
        fee: call.fee,
        recipient: call.recipient,
        amountIn: call.amount_in,
        minOut: call.min_out,
      });
  }
}

/**
 * Calldata the step expects. A swap's `min_out` was chosen when the request was
 * created (possibly by an earlier run), so it is taken from the signed data; every
 * other field must match.
 */
function expectedData(call: ForeignCall, signedData: string): string {
  if (call.kind !== "swap_exact_in") return callData(call);
  const minOutWord = signedData.slice(10 + 5 * 64, 10 + 6 * 64);
  if (minOutWord.length !== 64) return callData(call);
  return callData({ ...call, min_out: BigInt(`0x${minOutWord}`) });
}
