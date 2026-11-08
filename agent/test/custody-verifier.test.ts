import { describe, expect, it } from "vitest";
import { receiptKey, verifyDeposit, type AssetMapping, type FinalitySource, type SourceBlock, type SourceLog, type SourceReceipt } from "../src/custody-verifier.js";
import { TRANSFER_TOPIC, keccakHex } from "../src/evm-abi.js";

const custody = "0x0000000000000000000000000000000000000123";
const token = "0x00000000000000000000000000000000000000ab";
const other = "0x00000000000000000000000000000000000000ee";
const refund = "0x000000000000000000000000000000000000beef";
const sender = "0x00000000000000000000000000000000000000cd";
const tx = `0x${"11".repeat(32)}`;
const hashOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const word = (v: bigint) => v.toString(16).padStart(64, "0");
const topicAddr = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const mapping: AssetMapping = { chainId: 46630n, token, custody, custodyDomain: "robinhood-testnet", representation: "rep.testnet", mappingVersion: 3n };
const DEPOSIT = keccakHex("Deposited(uint256,address,address,uint64,uint64,address,string,uint256,uint256)");

function depositLog(opts: { token?: string; received?: bigint; version?: bigint; beneficiary?: string; logIndex?: number; refund?: bigint } = {}): SourceLog {
  const ben = Buffer.from(opts.beneficiary ?? "alice.testnet", "utf8");
  return {
    address: custody, logIndex: opts.logIndex ?? 1, blockHash: hashOf(5), transactionHash: tx,
    topics: [DEPOSIT, `0x${word(1n)}`, topicAddr(opts.token ?? token), topicAddr(sender)],
    data: `0x${word(7n)}${word(opts.version ?? 3n)}${word(opts.refund ?? BigInt(refund))}${word(192n)}${word(100n)}${word(opts.received ?? 98n)}${word(BigInt(ben.length))}${ben.toString("hex").padEnd(64, "0")}`,
  };
}
const transferLog = (amount: bigint, t = token): SourceLog => ({
  address: t, logIndex: 0, blockHash: hashOf(5), transactionHash: tx,
  topics: [TRANSFER_TOPIC, topicAddr(sender), topicAddr(custody)], data: `0x${word(amount)}`,
});

function chain(over: Partial<{ finalized: number | null; logs: SourceLog[]; status: boolean; receiptBlock: string; forkAt: number; before: bigint; after: bigint; chain: bigint }> = {}) {
  const finalized = over.finalized === undefined ? 8 : over.finalized;
  const blocks = new Map<bigint, SourceBlock>();
  for (let n = 0; n <= 10; n++) blocks.set(BigInt(n), { number: BigInt(n), hash: n === 5 && over.forkAt === 5 ? hashOf(999) : hashOf(n), parentHash: hashOf(n - 1 < 0 ? 0 : n - 1) });
  const receipt: SourceReceipt = { transactionHash: tx, status: over.status ?? true, blockNumber: 5n, blockHash: over.receiptBlock ?? hashOf(5), logs: over.logs ?? [transferLog(98n), depositLog()] };
  const source: FinalitySource = {
    chainId: async () => over.chain ?? 46630n,
    finalizedBlock: async () => (finalized === null ? null : blocks.get(BigInt(finalized))!),
    blockByNumber: async (n) => blocks.get(n) ?? null,
    receipt: async (h) => (h.toLowerCase() === tx ? receipt : null),
    balanceOfAt: async (_t, _a, n) => (n === 4n ? (over.before ?? 1000n) : (over.after ?? 1098n)),
  };
  return source;
}
const run = (source: FinalitySource, opts = {}, battleId?: bigint) => verifyDeposit(source, mapping, { transactionHash: tx, logIndex: 1, battleId }, opts);

describe("finalized custody deposit verifier", () => {
  it("attests the actual received amount, not the nominal one, with finalized evidence", async () => {
    const v = await run(chain(), {}, 7n);
    expect(v.status).toBe("verified");
    if (v.status !== "verified") return;
    expect(v.attestation).toMatchObject({ actualReceived: 98n, beneficiary: "alice.testnet", refundAddress: refund, blockNumber: 5n, finalizedHeadNumber: 8n, mappingVersion: 3n, representation: "rep.testnet" });
    expect(v.attestation.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("keeps unfinalized, unavailable or non-canonical evidence Pending", async () => {
    expect((await run(chain({ finalized: 4 }))).status).toBe("pending");
    expect((await run(chain({ finalized: null }))).status).toBe("pending");
    expect((await run(chain({ receiptBlock: hashOf(77) }))).status).toBe("pending");
    expect((await run(chain({ forkAt: 5 }))).status).toBe("pending");
    expect((await run(chain({ chain: 1n }))).status).toBe("pending");
    expect((await run(chain(), { maxAncestryDepth: 1n })).status).toBe("pending");
  });

  it("rejects wrong asset, version, battle, failed and unattributed receipts", async () => {
    expect((await run(chain({ logs: [transferLog(98n, other), depositLog({ token: other })] }))).status).toBe("rejected");
    expect((await run(chain({ logs: [transferLog(98n), depositLog({ version: 2n })] }))).status).toBe("rejected");
    expect((await run(chain(), {}, 8n)).status).toBe("rejected");
    expect((await run(chain({ status: false }))).status).toBe("rejected");
    expect((await run(chain({ logs: [transferLog(98n), depositLog({ beneficiary: "Not A Near!" })] }))).status).toBe("rejected");
    expect((await run(chain({ logs: [transferLog(98n), depositLog({ logIndex: 2 })] }))).status).toBe("rejected");
  });

  it("rejects a deposit with no bound refund address and carries the bound one into the evidence", async () => {
    expect((await run(chain({ logs: [transferLog(98n), depositLog({ refund: 0n })] }))).status).toBe("rejected");
    const a = await run(chain({ logs: [transferLog(98n), depositLog({ refund: 0xbeefn })] }));
    const b = await run(chain({ logs: [transferLog(98n), depositLog({ refund: 0xcafen })] }));
    expect(a.status === "verified" && b.status === "verified" && a.attestation.evidenceHash !== b.attestation.evidenceHash).toBe(true);
  });

  it("rejects declared amounts that custody did not actually receive", async () => {
    expect((await run(chain({ logs: [transferLog(90n), depositLog()] }))).status).toBe("rejected");
    expect((await run(chain({ logs: [depositLog()] }))).status).toBe("rejected");
    expect((await run(chain({ before: 1000n, after: 1050n }))).status).toBe("rejected");
  });

  it("never treats a direct transfer or donation without a custody event as a deposit", async () => {
    expect((await run(chain({ logs: [transferLog(98n)] }))).status).toBe("rejected");
    const wrongEmitter = { ...depositLog(), address: other };
    expect((await run(chain({ logs: [transferLog(98n), wrongEmitter] }))).status).toBe("rejected");
  });

  it("rejects an already-consumed receipt key", async () => {
    const key = receiptKey(46630n, tx.toUpperCase().replace("0X", "0x"), 1);
    const v = await run(chain(), { isConsumed: async (k: string) => k === key });
    expect(v).toEqual({ status: "rejected", reason: "receipt already consumed" });
  });
});
