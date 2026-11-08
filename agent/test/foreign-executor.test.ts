import { describe, expect, it } from "vitest";
import { SEL_APPROVE, SEL_EXACT_INPUT_SINGLE, SEL_TRANSFER } from "../src/evm-abi.js";
import { StaticAddressResolver } from "../src/evm-address.js";
import { StaticEvmQuoteSource, UniswapV3QuoterSource } from "../src/evm-quote.js";
import { FakeEvmRpc } from "../src/fake-evm-rpc.js";
import { FakeArenaClient, makeBattle } from "../src/fake-client.js";
import {
  ForeignChainStepExecutor,
  ForeignExecutionError,
  type ForeignExecutorConfig,
} from "../src/foreign-executor.js";
import { driveSettlement } from "../src/settlement.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROUTER = "0x1000000000000000000000000000000000000001";
const TREASURY = "0x2000000000000000000000000000000000000002";
const BURN = "0x000000000000000000000000000000000000dead";
const USDC = "0x3000000000000000000000000000000000000003";
const WINNER = "0x4000000000000000000000000000000000000004";
const LOSER = "0x5000000000000000000000000000000000000005";
const QUOTER = "0x6000000000000000000000000000000000000006";

const ETH = 10n ** 18n;

function setup(over: Partial<ForeignExecutorConfig> = {}) {
  const client = new FakeArenaClient([
    makeBattle({ id: 1, status: "Settling", winner: "A", token_a: "winner.testnet", token_b: "loser.testnet" }),
  ]);
  client.foreign = {
    mpc_contract: "signer.testnet",
    chain_id: "1337",
    router: ROUTER.slice(2),
    treasury: TREASURY.slice(2),
    burn: BURN.slice(2),
  };
  client.signerAddress = () => WALLET;
  client.putPlan(1, [
    { index: 0, kind: "Dump", amount: "1000", done: false, dispatched: false, realized: null },
    { index: 1, kind: "Buy", amount: "900", done: false, dispatched: false, realized: null },
    { index: 2, kind: "Burn", amount: "40", done: false, dispatched: false, realized: null },
    { index: 3, kind: "Return", amount: "60", done: false, dispatched: false, realized: null },
  ]);
  const rpc = new FakeEvmRpc();
  rpc.router = ROUTER;
  rpc.quoterAddress = QUOTER;
  rpc.setEth(WALLET, ETH);
  rpc.setToken(LOSER, WALLET, 1000n);
  rpc.setRate(LOSER, USDC, 2n, 1n); // 1000 loser -> 2000 USDC
  rpc.setRate(USDC, WINNER, 3n, 1n); // 900 USDC -> 2700 winner, 40 USDC -> 120
  const config: ForeignExecutorConfig = {
    chainId: 1337n,
    usdc: USDC,
    tokenMap: new Map([
      ["winner.testnet", WINNER],
      ["loser.testnet", LOSER],
    ]),
    feeTier: 3000,
    confirmations: 2,
    maxSignaturePolls: 3,
    maxReceiptPolls: 3,
    pollIntervalMs: 1,
    ...over,
  };
  const make = (quotes = new UniswapV3QuoterSource(rpc, QUOTER, 500)) =>
    new ForeignChainStepExecutor(config, {
      client,
      rpc,
      resolver: new StaticAddressResolver(() => WALLET),
      quotes,
      // Each wait lets one block pass, as time would.
      sleep: async () => rpc.advanceBlocks(1n),
    });
  return { client, rpc, config, make };
}

const reports = (client: FakeArenaClient) => client.calls.filter((c) => c.method === "report_execution");
const sent = (rpc: FakeEvmRpc, selector: string) =>
  rpc.broadcasts.filter((h) => rpc.known.get(h)?.data.startsWith(selector)).length;

describe("ForeignChainStepExecutor", () => {
  it("runs all four steps once, reports each once and settles", async () => {
    const { client, rpc, make } = setup();
    const result = await driveSettlement(client, make(), 1);

    expect(result.reported).toEqual([0, 1, 2, 3]);
    expect(reports(client).map((c) => (c as { realized: bigint }).realized)).toEqual([2000n, 2700n, 120n, 60n]);
    expect(client.status(1)).toBe("Settled");
    expect(rpc.tokenBalance(USDC, WALLET)).toBe(2000n - 900n - 40n - 60n);
    expect(rpc.tokenBalance(WINNER, WALLET)).toBe(2700n);
    expect(rpc.tokenBalance(WINNER, BURN)).toBe(120n);
    expect(rpc.tokenBalance(USDC, TREASURY)).toBe(60n);
    // Three approvals (loser, then USDC twice), three swaps, one transfer.
    expect(sent(rpc, SEL_APPROVE)).toBe(3);
    expect(sent(rpc, SEL_EXACT_INPUT_SINGLE)).toBe(3);
    expect(sent(rpc, SEL_TRANSFER)).toBe(1);
  });

  it("signs calls that fit their plan steps", async () => {
    const { client, make } = setup();
    await driveSettlement(client, make(), 1);
    const swaps = client.calls.filter(
      (c) => c.method === "request_signature" && c.call.kind === "swap_exact_in",
    );
    const burn = swaps[2] as { call: { recipient: string } };
    expect(burn.call.recipient).toBe(BURN);
    const ret = client.calls.find((c) => c.method === "request_signature" && c.call.kind === "transfer") as {
      call: { to: string; token: string };
    };
    expect(ret.call).toMatchObject({ to: TREASURY, token: USDC });
  });

  it("skips the approval when the allowance is enough", async () => {
    const { client, rpc, make } = setup();
    rpc.setAllowance(LOSER, WALLET, ROUTER, 5000n);
    const ex = make();
    expect(await ex.execute((await client.getSettlementPlan(1))[0]!, (await client.getBattle(1))!)).toBe(2000n);
    expect(sent(rpc, SEL_APPROVE)).toBe(0);
    expect(client.calls.filter((c) => c.method === "request_signature")).toHaveLength(1);
  });

  it("a second pass continues after a stop instead of repeating work", async () => {
    const { client, rpc, make } = setup();
    // The node refuses the broadcast of the third transaction (the Buy approval).
    const original = rpc.sendRawTransaction.bind(rpc);
    let n = 0;
    rpc.sendRawTransaction = async (raw) => {
      if (++n === 3) throw new Error("EVM RPC eth_sendRawTransaction request failed: error");
      return original(raw);
    };
    await expect(driveSettlement(client, make(), 1)).rejects.toThrow("request failed");
    expect(reports(client)).toHaveLength(1);
    const requestsBefore = await client.getSignatureRequestCount();
    expect(requestsBefore).toBe(3); // dump approve, dump swap, buy approve (signed, not sent)

    // New process: same chain state.
    const result = await driveSettlement(client, make(), 1);
    expect(result.reported).toEqual([1, 2, 3]);
    expect(reports(client)).toHaveLength(4);
    expect(client.status(1)).toBe("Settled");
    expect(sent(rpc, SEL_EXACT_INPUT_SINGLE)).toBe(3); // the Dump swap was not repeated
    // The unsent approval was resumed, not re-requested; only 7 requests exist in total.
    expect(await client.getSignatureRequestCount()).toBe(7);
  });

  it("does not broadcast again or double report after an executed step failed to report", async () => {
    const { client, rpc, make } = setup();
    const realReport = client.reportExecution.bind(client);
    let failOnce = true;
    client.reportExecution = async (b, i, r) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("rpc down");
      }
      return realReport(b, i, r);
    };
    await expect(driveSettlement(client, make(), 1)).rejects.toThrow("rpc down");
    const broadcastsBefore = rpc.broadcasts.length;
    const result = await driveSettlement(client, make(), 1);
    expect(result.reported).toEqual([0, 1, 2, 3]);
    expect(rpc.broadcasts.length - broadcastsBefore).toBe(5); // steps 1..3 only: 2 approves, 2 swaps, 1 transfer
    expect(reports(client).map((c) => (c as { stepIndex: number }).stepIndex)).toEqual([0, 1, 2, 3]);
  });

  it("waits for confirmations and does not re-send a known transaction", async () => {
    const { client, rpc, make } = setup({ maxReceiptPolls: 1 });
    rpc.manualMining = true;
    await expect(make().execute((await client.getSettlementPlan(1))[0]!, (await client.getBattle(1))!)).rejects.toMatchObject(
      { code: "not_confirmed" },
    );
    expect(rpc.broadcasts).toHaveLength(1);
    // Retry while still unmined: the approval is resumed from the mempool, not sent again.
    await expect(make().execute((await client.getSettlementPlan(1))[0]!, (await client.getBattle(1))!)).rejects.toMatchObject(
      { code: "not_confirmed" },
    );
    expect(rpc.broadcasts).toHaveLength(1);
    rpc.manualMining = false;
    rpc.mine();
    const out = await make().execute((await client.getSettlementPlan(1))[0]!, (await client.getBattle(1))!);
    expect(out).toBe(2000n);
    expect(rpc.broadcasts).toHaveLength(2);
  });

  it("retries a failed signature and then succeeds", async () => {
    const { client, make } = setup();
    client.failSignatures = 2;
    const out = await make().execute((await client.getSettlementPlan(1))[0]!, (await client.getBattle(1))!);
    expect(out).toBe(2000n);
    expect(client.calls.filter((c) => c.method === "retry_signature")).toHaveLength(2);
  });

  it("stops when the contract's signature attempts are exhausted", async () => {
    const { client, rpc, make } = setup();
    client.failSignatures = 100;
    await expect(make().execute((await client.getSettlementPlan(1))[0]!, (await client.getBattle(1))!)).rejects.toMatchObject(
      { code: "signature_exhausted" },
    );
    expect(client.calls.filter((c) => c.method === "retry_signature")).toHaveLength(4);
    expect(rpc.broadcasts).toHaveLength(0);
  });

  it("waits for a slow signer and resumes on the next pass without a second request", async () => {
    const { client, make } = setup();
    client.autoSign = false;
    const step = (await client.getSettlementPlan(1))[0]!;
    const battle = (await client.getBattle(1))!;
    await expect(make().execute(step, battle)).rejects.toMatchObject({ code: "signature_pending" });
    client.signPending();
    // The approval is signed now; the swap request comes after it is mined.
    await expect(make().execute(step, battle)).rejects.toMatchObject({ code: "signature_pending" });
    client.signPending();
    expect(await make().execute(step, battle)).toBe(2000n);
    expect(await client.getSignatureRequestCount()).toBe(2);
  });

  it("does not report a reverted transaction and stays stopped", async () => {
    const { client, rpc, make } = setup();
    rpc.shouldRevert = (tx) => tx.data.startsWith(SEL_EXACT_INPUT_SINGLE);
    await expect(driveSettlement(client, make(), 1)).rejects.toBeInstanceOf(ForeignExecutionError);
    expect(reports(client)).toHaveLength(0);
    const requests = await client.getSignatureRequestCount();
    const broadcasts = rpc.broadcasts.length;
    await expect(driveSettlement(client, make(), 1)).rejects.toMatchObject({ code: "reverted" });
    expect(reports(client)).toHaveLength(0);
    expect(await client.getSignatureRequestCount()).toBe(requests);
    expect(rpc.broadcasts.length).toBe(broadcasts);
  });

  it("refuses to sign without a safe quote", async () => {
    const { client, rpc, make } = setup();
    rpc.failQuote = true;
    const step = (await client.getSettlementPlan(1))[0]!;
    await expect(make().execute(step, (await client.getBattle(1))!)).rejects.toThrow("no safe swap quote");
    expect(rpc.broadcasts).toHaveLength(0);
    const ex = make(new StaticEvmQuoteSource(new Error("no pool")) as never);
    await expect(ex.execute(step, (await client.getBattle(1))!)).rejects.toThrow("no safe swap quote");
  });

  it("stops before signing when the wallet cannot pay for gas or lacks the tokens", async () => {
    const { client, rpc, make } = setup();
    const step = (await client.getSettlementPlan(1))[0]!;
    const battle = (await client.getBattle(1))!;
    rpc.setEth(WALLET, 0n);
    await expect(make().execute(step, battle)).rejects.toMatchObject({ code: "insufficient_funds" });
    rpc.setEth(WALLET, ETH);
    rpc.setToken(LOSER, WALLET, 10n);
    await expect(make().execute(step, battle)).rejects.toMatchObject({ code: "insufficient_funds" });
    expect(await client.getSignatureRequestCount()).toBe(0);
  });

  it("detects a nonce taken by another transaction", async () => {
    const { client, rpc, config } = setup();
    client.autoSign = false;
    const ex = new ForeignChainStepExecutor(config, {
      client,
      rpc,
      resolver: new StaticAddressResolver(() => WALLET),
      quotes: new UniswapV3QuoterSource(rpc, QUOTER, 500),
      // While the signer works, another transaction uses the wallet's nonce.
      sleep: async () => {
        rpc.nonces.set(WALLET, 5n);
        client.signPending();
      },
    });
    const step = (await client.getSettlementPlan(1))[0]!;
    await expect(ex.execute(step, (await client.getBattle(1))!)).rejects.toMatchObject({
      code: "nonce_consumed",
    });
    expect(rpc.broadcasts).toHaveLength(0);
  });

  it("rejects a mismatched chain id and a missing foreign config", async () => {
    const { client, make } = setup();
    const step = (await client.getSettlementPlan(1))[0]!;
    const battle = (await client.getBattle(1))!;
    client.foreign = { ...client.foreign!, chain_id: "1" };
    await expect(make().execute(step, battle)).rejects.toThrow("differs from FOREIGN_CHAIN_ID");
    client.foreign = null;
    await expect(make().execute(step, battle)).rejects.toThrow("no foreign-chain configuration");
  });

  it("refuses to sign when the RPC serves a different chain, and keeps checking after the first pass", async () => {
    const { client, rpc, make } = setup();
    const plan = await client.getSettlementPlan(1);
    const battle = (await client.getBattle(1))!;
    const ex = make();
    rpc.chain = 1n;
    await expect(ex.execute(plan[0]!, battle)).rejects.toThrow("the RPC serves chain 1, expected 1337");
    expect(rpc.broadcasts).toHaveLength(0);
    expect((client as unknown as { signRequests: Map<number, unknown> }).signRequests.size).toBe(0);

    // A first successful pass must not cache trust: a swapped RPC is caught on the next step.
    rpc.chain = 1337n;
    await ex.execute(plan[0]!, battle);
    rpc.chain = 5n;
    const before = rpc.broadcasts.length;
    await expect(ex.execute(plan[1]!, battle)).rejects.toThrow("expected 1337");
    expect(rpc.broadcasts).toHaveLength(before);
  });

  it("fails closed when the RPC chain id is malformed", async () => {
    const { client, rpc, make } = setup();
    (rpc as { chainId: () => Promise<bigint> }).chainId = async () => undefined as unknown as bigint;
    const plan = await client.getSettlementPlan(1);
    await expect(make().execute(plan[0]!, (await client.getBattle(1))!)).rejects.toThrow("malformed chain id");
    expect(rpc.broadcasts).toHaveLength(0);
  });

  it("books a zero-amount step without sending anything", async () => {
    const { client, rpc, make } = setup();
    const battle = (await client.getBattle(1))!;
    const zero = { index: 3, kind: "Return" as const, amount: "0", done: false, dispatched: false, realized: null };
    expect(await make().execute(zero, battle)).toBe(0n);
    expect(rpc.broadcasts).toHaveLength(0);
  });
});
