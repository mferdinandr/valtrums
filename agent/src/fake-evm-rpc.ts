import { SEL_APPROVE, SEL_EXACT_INPUT_SINGLE, SEL_TRANSFER, SEL_BALANCE_OF, SEL_ALLOWANCE, SEL_QUOTE_EXACT_INPUT_SINGLE, TRANSFER_TOPIC, normalizeAddress } from "./evm-abi.js";
import { type DecodedTx, decodeTx, txHash } from "./evm-tx.js";
import type { EvmFees, EvmLog, EvmReceipt, EvmRpc } from "./evm-rpc.js";

const word = (v: bigint | string): string =>
  (typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/, "")).padStart(64, "0");
const addrOfWord = (w: string): string => `0x${w.slice(24)}`;

/**
 * In-memory EVM chain for tests: ETH balances, ERC-20 tokens, a Uniswap-style
 * router with fixed rates, nonces and blocks. Transactions mine at once when
 * broadcast. The sender of a signed transaction is read from its `r` field
 * (test signers put the 20-byte sender address there; nothing is recovered).
 */
export class FakeEvmRpc implements EvmRpc {
  chain = 1337n;
  head = 100n;
  fees: EvmFees = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n };
  router = "";
  /** Rates `tokenIn -> tokenOut` as [num, den]; out = in * num / den. */
  readonly rates = new Map<string, [bigint, bigint]>();
  /** What the quoter answers; defaults to the router rate. */
  quoterAddress = "";
  failQuote = false;

  readonly nonces = new Map<string, bigint>();
  readonly eth = new Map<string, bigint>();
  readonly tokenBalances = new Map<string, bigint>();
  readonly allowances = new Map<string, bigint>();
  readonly known = new Map<string, DecodedTx>();
  readonly receipts = new Map<string, EvmReceipt>();
  /** Every raw transaction passed to sendRawTransaction, in order. */
  readonly broadcasts: string[] = [];
  /** Next transactions revert (consumed one per transaction). */
  revertNext = 0;
  /** Next sendRawTransaction calls throw after storing nothing. */
  failSend = 0;
  /** When set, a broadcast is accepted into the mempool but not mined until `mine()`. */
  manualMining = false;
  private pending: string[] = [];

  setEth(address: string, wei: bigint): void {
    this.eth.set(normalizeAddress(address), wei);
  }

  setToken(token: string, owner: string, amount: bigint): void {
    this.tokenBalances.set(`${normalizeAddress(token)}:${normalizeAddress(owner)}`, amount);
  }

  tokenBalance(token: string, owner: string): bigint {
    return this.tokenBalances.get(`${normalizeAddress(token)}:${normalizeAddress(owner)}`) ?? 0n;
  }

  setAllowance(token: string, owner: string, spender: string, amount: bigint): void {
    this.allowances.set(`${normalizeAddress(token)}:${normalizeAddress(owner)}:${normalizeAddress(spender)}`, amount);
  }

  allowance(token: string, owner: string, spender: string): bigint {
    return this.allowances.get(`${normalizeAddress(token)}:${normalizeAddress(owner)}:${normalizeAddress(spender)}`) ?? 0n;
  }

  setRate(tokenIn: string, tokenOut: string, num: bigint, den: bigint): void {
    this.rates.set(`${normalizeAddress(tokenIn)}:${normalizeAddress(tokenOut)}`, [num, den]);
  }

  advanceBlocks(n: bigint): void {
    this.head += n;
  }

  async chainId(): Promise<bigint> {
    return this.chain;
  }
  async blockNumber(): Promise<bigint> {
    return this.head;
  }
  async getTransactionCount(address: string): Promise<bigint> {
    return this.nonces.get(normalizeAddress(address)) ?? 0n;
  }
  async getBalance(address: string): Promise<bigint> {
    return this.eth.get(normalizeAddress(address)) ?? 0n;
  }
  async getFees(): Promise<EvmFees> {
    return this.fees;
  }
  async estimateGas(): Promise<bigint> {
    return 100_000n;
  }

  async call(tx: { to: string; data: string }): Promise<string> {
    const to = normalizeAddress(tx.to);
    const sel = tx.data.slice(0, 10);
    const args = tx.data.slice(10);
    if (sel === SEL_BALANCE_OF) {
      return `0x${word(this.tokenBalance(to, addrOfWord(args.slice(0, 64))))}`;
    }
    if (sel === SEL_ALLOWANCE) {
      return `0x${word(this.allowance(to, addrOfWord(args.slice(0, 64)), addrOfWord(args.slice(64, 128))))}`;
    }
    if (sel === SEL_QUOTE_EXACT_INPUT_SINGLE && to === normalizeAddress(this.quoterAddress)) {
      if (this.failQuote) throw new Error("EVM RPC eth_call error: execution reverted");
      const tokenIn = addrOfWord(args.slice(0, 64));
      const tokenOut = addrOfWord(args.slice(64, 128));
      const amountIn = BigInt(`0x${args.slice(128, 192)}`);
      const rate = this.rates.get(`${tokenIn}:${tokenOut}`);
      if (!rate) throw new Error("EVM RPC eth_call error: execution reverted");
      // QuoterV2 returns (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate).
      return `0x${word((amountIn * rate[0]) / rate[1])}${word(0n)}${word(0n)}${word(0n)}`;
    }
    throw new Error("EVM RPC eth_call error: unsupported call in fake");
  }

  async sendRawTransaction(rawHex: string): Promise<string> {
    const raw = rawHex.replace(/^0x/, "");
    if (this.failSend > 0) {
      this.failSend--;
      throw new Error("EVM RPC eth_sendRawTransaction request failed: error");
    }
    const hash = txHash(raw);
    this.broadcasts.push(hash);
    const tx = decodeTx(raw);
    if (this.known.has(hash)) throw new Error("EVM RPC eth_sendRawTransaction error: already known");
    this.known.set(hash, tx);
    this.pending.push(hash);
    if (!this.manualMining) this.mine();
    return hash;
  }

  /** Mine all pending transactions into one new block. */
  mine(): void {
    this.head += 1n;
    for (const hash of this.pending.splice(0)) this.apply(hash, this.known.get(hash) as DecodedTx);
  }

  private apply(hash: string, tx: DecodedTx): void {
    const sender = normalizeAddress(`0x${Buffer.from(tx.r as Uint8Array).toString("hex").slice(-40)}`);
    const expected = this.nonces.get(sender) ?? 0n;
    if (tx.nonce !== expected) {
      this.known.delete(hash);
      throw new Error("EVM RPC eth_sendRawTransaction error: nonce too low");
    }
    this.nonces.set(sender, expected + 1n);
    let logs: EvmLog[] | null = [];
    if (this.revertNext > 0) {
      this.revertNext--;
      logs = null;
    } else {
      logs = this.execute(sender, tx);
    }
    this.receipts.set(hash, {
      transactionHash: hash,
      status: logs !== null,
      blockNumber: this.head,
      logs: logs ?? [],
    });
  }

  private moveToken(token: string, from: string, to: string, amount: bigint, logs: EvmLog[]): boolean {
    if (this.tokenBalance(token, from) < amount) return false;
    this.setToken(token, from, this.tokenBalance(token, from) - amount);
    this.setToken(token, to, this.tokenBalance(token, to) + amount);
    logs.push({
      address: token,
      topics: [TRANSFER_TOPIC, `0x${word(from)}`, `0x${word(to)}`],
      data: `0x${word(amount)}`,
    });
    return true;
  }

  /** Returns the logs, or null when the call reverts. */
  private execute(sender: string, tx: DecodedTx): EvmLog[] | null {
    const sel = tx.data.slice(0, 10);
    const a = tx.data.slice(10);
    const logs: EvmLog[] = [];
    if (sel === SEL_APPROVE) {
      this.setAllowance(tx.to, sender, addrOfWord(a.slice(0, 64)), BigInt(`0x${a.slice(64, 128)}`));
      return logs;
    }
    if (sel === SEL_TRANSFER) {
      return this.moveToken(tx.to, sender, addrOfWord(a.slice(0, 64)), BigInt(`0x${a.slice(64, 128)}`), logs)
        ? logs
        : null;
    }
    if (sel === SEL_EXACT_INPUT_SINGLE && tx.to === normalizeAddress(this.router)) {
      const tokenIn = addrOfWord(a.slice(0, 64));
      const tokenOut = addrOfWord(a.slice(64, 128));
      const recipient = addrOfWord(a.slice(192, 256));
      const amountIn = BigInt(`0x${a.slice(256, 320)}`);
      const minOut = BigInt(`0x${a.slice(320, 384)}`);
      const rate = this.rates.get(`${tokenIn}:${tokenOut}`);
      if (!rate) return null;
      const out = (amountIn * rate[0]) / rate[1];
      if (out < minOut || this.allowance(tokenIn, sender, this.router) < amountIn) return null;
      this.setAllowance(tokenIn, sender, this.router, this.allowance(tokenIn, sender, this.router) - amountIn);
      if (!this.moveToken(tokenIn, sender, this.router, amountIn, logs)) return null;
      this.setToken(tokenOut, this.router, this.tokenBalance(tokenOut, this.router) + out);
      if (!this.moveToken(tokenOut, this.router, recipient, out, logs)) return null;
      return logs;
    }
    return null;
  }

  async getTransactionReceipt(hash: string): Promise<EvmReceipt | null> {
    return this.receipts.get(hash) ?? null;
  }

  async isTransactionKnown(hash: string): Promise<boolean> {
    return this.known.has(hash);
  }
}
