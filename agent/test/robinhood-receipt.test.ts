import { describe, it, expect } from "vitest";
import { TRANSFER_TOPIC } from "../src/evm-abi.js";
import { verifyRobinhoodTransfer, RobinhoodJsonRpc, type TransferRequest, type ReceiptRpc } from "../src/robinhood-receipt.js";
const token = "0x" + "11".repeat(20), sender = "0x" + "22".repeat(20), custody = "0x" + "33".repeat(20);
const tx = "0x" + "aa".repeat(32), blockHash = "0x" + "bb".repeat(32);
const topic = (a: string) => "0x" + "0".repeat(24) + a.slice(2);
const request: TransferRequest = { transactionHash: tx, token, sender, custody, maxReceived: 100n, confirmations: 3n };
function fixture() {
  const log = { address: token, topics: [TRANSFER_TOPIC, topic(sender), topic(custody)], data: "0x" + (98n).toString(16).padStart(64, "0"), blockHash, blockNumber: "0xa", transactionHash: tx, logIndex: "0x0", removed: false };
  const receipt = { transactionHash: tx, status: "0x1", blockNumber: "0xa", blockHash, logs: [log] };
  const responses: Record<string, unknown> = { eth_chainId: "0xb626", eth_getTransactionReceipt: receipt, eth_blockNumber: "0xc", eth_getBlockByNumber: { hash: blockHash, number: "0xa" } };
  const rpc: ReceiptRpc = { async request(method) { return responses[method]; } };
  return { log, receipt, responses, rpc };
}
describe("authorized Robinhood receipt verifier", () => {
  it("records actual received units and stable source receipt IDs without authorizing mint", async () => {
    const { rpc } = fixture(); const result = await verifyRobinhoodTransfer(rpc, request);
    expect(result).toMatchObject({ status: "Verified", received: 98n, receiptIds: [`46630:${tx}:0`], trustModel: "authorized-verifier" });
    expect(result).not.toHaveProperty("beneficiary");
  });
  it("rejects wrong chain", async () => { const f = fixture(); f.responses.eth_chainId = "0x1"; expect((await verifyRobinhoodTransfer(f.rpc, request)).status).toBe("Rejected"); });
  it("waits for finality and rejects stale canonical evidence", async () => {
    const f = fixture(); f.responses.eth_blockNumber = "0xb"; expect((await verifyRobinhoodTransfer(f.rpc, request)).status).toBe("Pending");
    f.responses.eth_blockNumber = "0xc"; f.responses.eth_getBlockByNumber = { hash: tx, number: "0xa" }; expect((await verifyRobinhoodTransfer(f.rpc, request)).status).toBe("Pending");
  });
  it("rejects reverts and another receipt", async () => {
    const f = fixture(); f.receipt.status = "0x0"; expect((await verifyRobinhoodTransfer(f.rpc, request)).status).toBe("Rejected");
    f.receipt.status = "0x1"; f.receipt.transactionHash = blockHash; expect((await verifyRobinhoodTransfer(f.rpc, request)).status).toBe("Rejected");
  });
  it("refuses donations or outgoing movements in the same receipt", async () => {
    const f = fixture(); f.log.topics[1] = topic(token); expect((await verifyRobinhoodTransfer(f.rpc, request)).status).toBe("Rejected");
    f.log.topics = [TRANSFER_TOPIC, topic(custody), topic(sender)]; expect((await verifyRobinhoodTransfer(f.rpc, request)).status).toBe("Rejected");
  });
  it("holds removed, duplicated, malformed and unbound logs", async () => {
    for (const mutation of [(f: ReturnType<typeof fixture>) => { f.log.removed = true; }, (f: ReturnType<typeof fixture>) => { f.receipt.logs.push(f.log); }, (f: ReturnType<typeof fixture>) => { f.log.data = "0x1"; }, (f: ReturnType<typeof fixture>) => { f.log.blockHash = tx; }, (f: ReturnType<typeof fixture>) => { f.log.topics[1] = "0x" + "ff".repeat(12) + sender.slice(2); }]) {
      const f = fixture(); mutation(f); expect((await verifyRobinhoodTransfer(f.rpc, request)).status).toBe("Pending");
    }
  });
  it("rejects missing transfers and excess units", async () => {
    const f = fixture(); expect((await verifyRobinhoodTransfer(f.rpc, { ...request, maxReceived: 97n })).status).toBe("Rejected");
    f.receipt.logs = []; expect((await verifyRobinhoodTransfer(f.rpc, request)).status).toBe("Rejected");
  });
  it("does not leak credential-bearing RPC errors", async () => {
    const result = await verifyRobinhoodTransfer({ async request() { throw new Error("https://secret:password@rpc/"); } }, request);
    expect(result.status).toBe("Pending"); expect(JSON.stringify(result)).not.toContain("password");
  });
  it("refuses invalid caller requests", async () => {
    const f = fixture(); await expect(verifyRobinhoodTransfer(f.rpc, { ...request, custody: sender })).rejects.toThrow("self-transfer");
    await expect(verifyRobinhoodTransfer(f.rpc, { ...request, confirmations: 0n })).rejects.toThrow();
  });
});

describe("receipt RPC transport", () => {
  it("binds responses to request ID and preserves a pending null receipt", async () => {
    const rpc = new RobinhoodJsonRpc("https://rpc.example", async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: null }));
    });
    expect(await rpc.request("eth_getTransactionReceipt", [tx])).toBeNull();
  });
  it("rejects mismatched IDs and redacts errors", async () => {
    const rpc = new RobinhoodJsonRpc("https://rpc.example/secret", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 99, result: "0x1" })));
    await expect(rpc.request("eth_chainId", [])).rejects.toThrow("receipt RPC request failed");
    const broken = new RobinhoodJsonRpc("https://rpc.example/secret", async () => { throw new Error("credential secret"); });
    await expect(broken.request("eth_chainId", [])).rejects.toThrow(/^receipt RPC request failed$/);
  });
  it("requires encrypted nonlocal endpoints", () => {
    expect(() => new RobinhoodJsonRpc("http://rpc.example")).toThrow("HTTPS");
    expect(() => new RobinhoodJsonRpc("http://127.0.0.1:8545")).not.toThrow();
  });
});
