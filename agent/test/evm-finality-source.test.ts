// FIXTURE tests: a fake JSON-RPC fetch stands in for the node. Not live evidence.
import { describe, expect, it } from "vitest";
import { RpcFinalitySource } from "../src/evm-finality-source.js";
import { pollVerdicts } from "../src/custody-verify-cli.js";
import { verifyDeposit, type AssetMapping } from "../src/custody-verifier.js";
import { TRANSFER_TOPIC, keccakHex } from "../src/evm-abi.js";

const custody = "0x00000000000000000000000000000000000000c1";
const holder = "0x00000000000000000000000000000000000000b1"; // the payout signing account; the deposit contract keeps nothing
const token = "0x00000000000000000000000000000000000000a1";
const sender = "0x00000000000000000000000000000000000000d1";
const tx = `0x${"22".repeat(32)}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const word = (v: bigint) => v.toString(16).padStart(64, "0");
const topicAddr = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const DEPOSIT = keccakHex("Deposited(uint256,address,address,uint64,uint64,address,string,uint256,uint256)");
const mapping: AssetMapping = { chainId: 46630n, token, custody, holder, custodyDomain: "robinhood-testnet", representation: "rep.testnet", mappingVersion: 3n };
const ben = Buffer.from("alice.testnet");

function fakeNode(state: { finalized: number; historical: boolean; calls?: string[] }) {
  const logs = [
    { address: token, topics: [TRANSFER_TOPIC, topicAddr(sender), topicAddr(holder)], data: `0x${word(100n)}`, logIndex: "0x0", blockHash: h(5), transactionHash: tx, removed: false },
    {
      address: custody, topics: [DEPOSIT, `0x${word(1n)}`, topicAddr(token), topicAddr(sender)], logIndex: "0x1", blockHash: h(5), transactionHash: tx, removed: false,
      data: `0x${word(1n)}${word(3n)}${word(BigInt(sender))}${word(192n)}${word(100n)}${word(100n)}${word(BigInt(ben.length))}${ben.toString("hex").padEnd(64, "0")}`,
    },
  ];
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    const { method, params, id } = JSON.parse(init.body as string) as { method: string; params: unknown[]; id: number };
    state.calls?.push(method);
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
    const block = (n: number) => ({ number: `0x${n.toString(16)}`, hash: h(n), parentHash: h(n - 1) });
    if (method === "eth_chainId") return reply("0xb626");
    if (method === "eth_getBlockByNumber") {
      const tag = params[0] as string;
      return reply(tag === "finalized" ? block(state.finalized) : block(Number(tag)));
    }
    if (method === "eth_getTransactionReceipt") {
      return reply({ transactionHash: tx, status: "0x1", blockNumber: "0x5", blockHash: h(5), logs });
    }
    if (method === "eth_call") {
      if (!state.historical) return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { message: "historical state is not available" } }));
      return reply(`0x${word(params[1] === "0x4" ? 1000n : 1100n)}`);
    }
    return new Response("{}", { status: 500 });
  };
  return fetch;
}

const request = { transactionHash: tx, logIndex: 1, battleId: 1n };

describe("RpcFinalitySource", () => {
  it("is pending before the receipt block is finalized and verified after", async () => {
    const state = { finalized: 3, historical: true };
    const source = new RpcFinalitySource("https://rpc.example.invalid/KEY", { fetch: fakeNode(state) });
    expect((await verifyDeposit(source, mapping, request)).status).toBe("pending");
    state.finalized = 8;
    const verdict = await verifyDeposit(source, mapping, request);
    expect(verdict.status).toBe("verified");
    if (verdict.status === "verified") {
      expect(verdict.attestation.actualReceived).toBe(100n);
      expect(verdict.attestation.beneficiary).toBe("alice.testnet");
      expect(verdict.attestation.refundAddress).toBe(sender);
    }
  });

  it("stays pending when the node has pruned historical state", async () => {
    const source = new RpcFinalitySource("https://rpc.example.invalid", { fetch: fakeNode({ finalized: 8, historical: false }) });
    const verdict = await verifyDeposit(source, mapping, request);
    expect(verdict).toEqual({ status: "pending", reason: "source evidence unavailable" });
  });

  it("returns null for an unsupported finalized tag and never leaks the url in errors", async () => {
    const failing = async () => new Response("{}", { status: 403 });
    const source = new RpcFinalitySource("https://rpc.example.invalid/SECRETKEY", { fetch: failing });
    expect(await source.finalizedBlock()).toBeNull();
    await expect(source.chainId()).rejects.toThrow(/HTTP status 403/);
    await expect(source.chainId()).rejects.not.toThrow(/SECRETKEY/);
  });

  it("reads historical balances from the state endpoint only", async () => {
    const main = { finalized: 8, historical: false, calls: [] as string[] };
    const state = { finalized: 8, historical: true, calls: [] as string[] };
    const nodes: Record<string, ReturnType<typeof fakeNode>> = { "https://main.invalid": fakeNode(main), "https://state.invalid": fakeNode(state) };
    const fetch = (url: string, init: RequestInit) => nodes[url]!(url, init);
    const source = new RpcFinalitySource("https://main.invalid", { fetch, stateUrl: "https://state.invalid" });
    expect((await verifyDeposit(source, mapping, request)).status).toBe("verified");
    expect(state.calls).toEqual(["eth_call", "eth_call"]);
    expect(main.calls).not.toContain("eth_call");
  });

  it("sends an honest user agent", async () => {
    let ua = "";
    const fetch = async (_u: string, init: RequestInit) => {
      ua = (init.headers as Record<string, string>)["user-agent"] ?? "";
      return new Response(JSON.stringify({ result: "0xb626" }));
    };
    await new RpcFinalitySource("https://rpc.example.invalid", { fetch }).chainId();
    expect(ua).toMatch(/^valtrum-custody-verifier/);
  });
});

describe("pollVerdicts", () => {
  it("records the pending to verified transition once each", async () => {
    const state = { finalized: 3, historical: true };
    const source = new RpcFinalitySource("https://rpc.example.invalid", { fetch: fakeNode(state) });
    let clock = 0;
    const timeline = await pollVerdicts(source, mapping, request, {
      waitSeconds: 100, pollSeconds: 10, now: () => clock,
      sleep: async (ms) => { clock += ms; if (clock >= 30_000) state.finalized = 8; },
    });
    expect(timeline.map((t) => t.verdict)).toEqual(["pending", "verified"]);
    expect(timeline[0]?.reason).toBe("receipt is not finalized");
    expect(timeline[1]?.elapsedSeconds).toBe(30);
    expect(JSON.stringify(timeline)).not.toMatch(/\d+n\b/);
  });

  it("stops at the wait limit while still pending", async () => {
    const source = new RpcFinalitySource("https://rpc.example.invalid", { fetch: fakeNode({ finalized: 3, historical: true }) });
    let clock = 0;
    const timeline = await pollVerdicts(source, mapping, request, { waitSeconds: 25, pollSeconds: 10, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.verdict).toBe("pending");
  });
});
