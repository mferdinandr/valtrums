import { TRANSFER_TOPIC, keccak, normalizeAddress, toHex } from "./evm-abi.js";
import { assertRpcChain } from "./chain-guard.js";
import { decodeCustodyDeposit, type CustodyLog } from "./custody-event.js";

/** Source-chain view the testnet operator needs. All reads must come from one authenticated endpoint. */
export interface SourceBlock { number: bigint; hash: string; parentHash: string }
export interface SourceLog extends CustodyLog { logIndex: number; blockHash: string; transactionHash: string }
export interface SourceReceipt { transactionHash: string; status: boolean; blockNumber: bigint; blockHash: string; logs: SourceLog[] }
export interface FinalitySource {
  chainId(): Promise<bigint>;
  /** The RPC `finalized` block, or null when the tag is unsupported. Never substitute `latest`. */
  finalizedBlock(): Promise<SourceBlock | null>;
  blockByNumber(number: bigint): Promise<SourceBlock | null>;
  receipt(transactionHash: string): Promise<SourceReceipt | null>;
  /** ERC-20 `balanceOf(account)` as of the end of the given block. */
  balanceOfAt(token: string, account: string, blockNumber: bigint): Promise<bigint>;
}

/** Immutable asset mapping committed by the lifecycle community. */
export interface AssetMapping {
  chainId: bigint;
  token: string;
  /** The deposit-attribution contract that emits `Deposited`. It holds no tokens. */
  custody: string;
  /**
   * The account that actually holds the deposited tokens: the account the payout contract signs for. The
   * `Transfer` and balance evidence are checked at this address, never at `custody`. It must differ from
   * `custody`: a deposit contract that keeps the tokens has no way to pay them out.
   */
  holder: string;
  custodyDomain: string;
  representation: string;
  mappingVersion: bigint;
}

export interface ReceiptRequest { transactionHash: string; logIndex: number; battleId?: bigint }

/** Mirrors the receipt-registry `Claim`, with unencoded source evidence. */
export interface FinalizedAttestation {
  chainId: bigint; transactionHash: string; logIndex: number;
  representation: string; token: string; custodyDomain: string; mappingVersion: bigint;
  beneficiary: string; /** EVM address bound at deposit time that a late deposit is returned to (D17). */ refundAddress: string;
  battleId: bigint; actualReceived: bigint;
  blockNumber: bigint; blockHash: string; finalizedHeadNumber: bigint; finalizedHeadHash: string;
  evidenceHash: string;
}

/** Pending may be retried later; Rejected never becomes a claim for this receipt. */
export type Verdict =
  | { status: "verified"; attestation: FinalizedAttestation }
  | { status: "pending"; reason: string }
  | { status: "rejected"; reason: string };

export interface VerifierOptions {
  /** Maximum finalized-chain walk from the head to the receipt block; beyond it the receipt stays Pending. */
  maxAncestryDepth?: bigint;
  /** Authoritative shared registry lookup. Local state alone cannot prevent cross-instance replay. */
  isConsumed?: (key: string) => Promise<boolean>;
}

const HASH = /^0x[0-9a-f]{64}$/i;
const NEAR_ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;
const sameHash = (a: string, b: string): boolean => HASH.test(a) && HASH.test(b) && a.toLowerCase() === b.toLowerCase();
const pending = (reason: string): Verdict => ({ status: "pending", reason });
const rejected = (reason: string): Verdict => ({ status: "rejected", reason });

export const receiptKey = (chainId: bigint, transactionHash: string, logIndex: number): string =>
  `${chainId}:${transactionHash.toLowerCase()}:${logIndex}`;

/**
 * Trusted-operator verification of one deposit event. The result is an operator
 * assertion for the registry, not a cryptographic proof of Robinhood state.
 * Any unavailable, contradictory or incomplete evidence yields Pending.
 */
export async function verifyDeposit(
  source: FinalitySource,
  mapping: AssetMapping,
  request: ReceiptRequest,
  options: VerifierOptions = {},
): Promise<Verdict> {
  if (!HASH.test(request.transactionHash) || !Number.isInteger(request.logIndex) || request.logIndex < 0) {
    return rejected("invalid receipt identity");
  }
  const token = normalizeAddress(mapping.token);
  const custody = normalizeAddress(mapping.custody);
  let holder: string;
  try { holder = normalizeAddress(mapping.holder); } catch { return rejected("mapping has no valid token holder address"); }
  if (holder === custody) return rejected("the token holder must not be the deposit contract: tokens kept there cannot be paid out");
  const key = receiptKey(mapping.chainId, request.transactionHash, request.logIndex);
  try {
    try {
      await assertRpcChain(source, mapping.chainId, "source endpoint");
    } catch (err) {
      return pending(err instanceof Error ? err.message : "source endpoint chain mismatch");
    }
    if (options.isConsumed && (await options.isConsumed(key))) return rejected("receipt already consumed");

    const finalized = await source.finalizedBlock();
    if (!finalized) return pending("finalized head unavailable");
    const receipt = await source.receipt(request.transactionHash);
    if (!receipt) return pending("receipt not found");
    if (!sameHash(receipt.transactionHash, request.transactionHash)) return pending("receipt hash mismatch");
    if (!receipt.status) return rejected("transaction failed");
    if (receipt.blockNumber > finalized.number) return pending("receipt is not finalized");

    // The receipt block must be an ancestor of (or equal to) the finalized head.
    const head = await source.blockByNumber(finalized.number);
    if (!head || !sameHash(head.hash, finalized.hash)) return pending("finalized head not canonical");
    const maxDepth = options.maxAncestryDepth ?? 256n;
    if (finalized.number - receipt.blockNumber > maxDepth) return pending("receipt too far below finalized head");
    let cursor = head;
    while (cursor.number > receipt.blockNumber) {
      const parent = await source.blockByNumber(cursor.number - 1n);
      if (!parent || !sameHash(parent.hash, cursor.parentHash)) return pending("ancestry check failed");
      cursor = parent;
    }
    if (!sameHash(cursor.hash, receipt.blockHash)) return pending("receipt block is not canonical");

    // Every log must belong to this transaction and block; decode each custody deposit.
    let target: ReturnType<typeof decodeCustodyDeposit> | null = null;
    let depositedTotal = 0n;
    for (const log of receipt.logs) {
      if (!sameHash(log.blockHash, receipt.blockHash) || !sameHash(log.transactionHash, receipt.transactionHash)) {
        return pending("log does not match receipt block");
      }
      if (normalizeAddress(log.address) !== custody || log.topics[0]?.toLowerCase() === TRANSFER_TOPIC) continue;
      let deposit;
      try { deposit = decodeCustodyDeposit(log, custody); } catch { return rejected("malformed custody event"); }
      if (deposit.token === token) depositedTotal += deposit.received;
      if (log.logIndex === request.logIndex) target = deposit;
    }
    if (!target) return rejected("no custody deposit at log index");
    if (target.token !== token) return rejected("wrong source token");
    if (target.mappingVersion !== mapping.mappingVersion) return rejected("mapping version mismatch");
    if (request.battleId !== undefined && target.battleId !== request.battleId) return rejected("battle mismatch");
    if (!NEAR_ACCOUNT.test(target.beneficiary)) return rejected("unattributed beneficiary");

    // Actual increase at the holder: token Transfer logs into the holder must equal the measured deposits,
    // and the holder's balance must have grown by at least that much across the block.
    let transferred = 0n;
    for (const log of receipt.logs) {
      if (normalizeAddress(log.address) !== token || log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
      if (!/^0x[0-9a-f]{64}$/i.test(log.data) || !/^0x[0-9a-f]{64}$/i.test(log.topics[2] ?? "")) return rejected("malformed Transfer log");
      if (normalizeAddress(`0x${log.topics[2]!.slice(26)}`) === holder) transferred += BigInt(log.data);
    }
    if (transferred !== depositedTotal) return rejected("measured amount differs from token transfers");
    if (receipt.blockNumber === 0n) return rejected("invalid receipt block");
    const [before, after] = await Promise.all([
      source.balanceOfAt(token, holder, receipt.blockNumber - 1n),
      source.balanceOfAt(token, holder, receipt.blockNumber),
    ]);
    if (after < before || after - before < transferred) return rejected("holder balance did not increase by the received amount");

    // Re-read the head: a moved or disputed finalized head means the evidence is stale.
    const recheck = await source.finalizedBlock();
    if (!recheck || recheck.number < finalized.number) return pending("finalized head regressed");
    const stillCanonical = await source.blockByNumber(receipt.blockNumber);
    if (!stillCanonical || !sameHash(stillCanonical.hash, receipt.blockHash)) return pending("receipt block reorganized");

    const evidence = JSON.stringify({
      chainId: mapping.chainId.toString(), tx: request.transactionHash.toLowerCase(), logIndex: request.logIndex,
      block: [receipt.blockNumber.toString(), receipt.blockHash.toLowerCase()],
      finalized: [finalized.number.toString(), finalized.hash.toLowerCase()],
      token, custody, holder, depositId: target.depositId.toString(), refundAddress: target.refundAddress, requested: target.requested.toString(),
      received: target.received.toString(), balances: [before.toString(), after.toString()],
    });
    return {
      status: "verified",
      attestation: {
        chainId: mapping.chainId, transactionHash: request.transactionHash.toLowerCase(), logIndex: request.logIndex,
        representation: mapping.representation, token, custodyDomain: mapping.custodyDomain,
        mappingVersion: mapping.mappingVersion, beneficiary: target.beneficiary, refundAddress: target.refundAddress, battleId: target.battleId,
        actualReceived: target.received, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash.toLowerCase(),
        finalizedHeadNumber: finalized.number, finalizedHeadHash: finalized.hash.toLowerCase(),
        evidenceHash: toHex(keccak(new TextEncoder().encode(evidence))),
      },
    };
  } catch {
    return pending("source evidence unavailable");
  }
}
