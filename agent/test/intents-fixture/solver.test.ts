// FIXTURE: the fake solver completes, fails or refunds. Settlement is an in-memory ledger, not a chain.
import { describe, expect, it } from "vitest";
import { FixtureCustody, FundingCredits, type CustodyReceipt } from "../../src/intents-fixture/custody.js";
import { FIXTURE_HEADER, FIXTURE_LABEL } from "../../src/intents-fixture/label.js";
import { IntentsFixtureService, TERMINAL_STATUSES } from "../../src/intents-fixture/service.js";
import { FakeSolver } from "../../src/intents-fixture/solver.js";
import { fixtureId, makeFixture, recording } from "./helpers.js";

const MAINNET_USDC = recording.dryQuotes.near_usdc_to_hood_usdg!.request.originAsset as string;
const MAINNET_USDG = recording.dryQuotes.near_usdc_to_hood_usdg!.request.destinationAsset as string;
const CUSTODY = "0x2222222222222222222222222222222222222222";

type Fixture = ReturnType<typeof makeFixture>;
type Body = Record<string, any>;

function committedQuote(f: Fixture, over: Record<string, unknown> = {}): { depositAddress: string; body: Body } {
  const res = f.call("POST", "/v0/quote", {
    dry: false,
    swapType: "EXACT_INPUT",
    originAsset: fixtureId(MAINNET_USDC),
    destinationAsset: fixtureId(MAINNET_USDG),
    amount: "10000000",
    slippageTolerance: 100,
    recipient: CUSTODY,
    refundTo: "alice.testnet",
    ...over,
  });
  expect(res.status).toBe(200);
  const body = res.body as Body;
  return { depositAddress: body.quote.depositAddress, body };
}

const status = (f: Fixture, depositAddress: string): Body => f.call("GET", `/v0/status?depositAddress=${depositAddress}`).body as Body;
const submit = (f: Fixture, depositAddress: string) => f.call("POST", "/v0/deposit/submit", { txHash: "fixture-origin-tx", depositAddress });

function runToEnd(f: Fixture, depositAddress: string): Body {
  submit(f, depositAddress);
  let s = status(f, depositAddress);
  for (let i = 0; i < 5 && !TERMINAL_STATUSES.includes(s.status); i++) s = status(f, depositAddress);
  return s;
}

describe("committed quote and status flow", () => {
  it("returns a deposit address, deadline and inactivity time only when not dry, and waits for the deposit", () => {
    const f = makeFixture();
    const { depositAddress, body } = committedQuote(f);
    expect(depositAddress).toMatch(/^[0-9a-f]{64}$/);
    expect(body.quote.deadline).toBeDefined();
    expect(body.quote.timeWhenInactive).toBeDefined();
    // No deposit has been submitted: polling never advances.
    for (let i = 0; i < 3; i++) expect(status(f, depositAddress).status).toBe("PENDING_DEPOSIT");
    expect(f.custody.receipts).toHaveLength(0);
  });

  it("moves PENDING_DEPOSIT -> KNOWN_DEPOSIT_TX -> PROCESSING -> SUCCESS and moves the mock token once", () => {
    const f = makeFixture("complete");
    const { depositAddress } = committedQuote(f);
    const sub = submit(f, depositAddress).body as Body;
    expect(sub.status).toBe("KNOWN_DEPOSIT_TX");
    expect(status(f, depositAddress).status).toBe("PROCESSING");
    const done = status(f, depositAddress);
    expect(done.status).toBe("SUCCESS");
    expect(done.swapDetails.amountOut).toBe("9904355");
    expect(done.swapDetails.destinationChainTxHashes).toHaveLength(1);
    expect(done.swapDetails.originChainTxHashes).toHaveLength(1);
    for (let i = 0; i < 3; i++) expect(status(f, depositAddress).status).toBe("SUCCESS");
    submit(f, depositAddress);
    expect(status(f, depositAddress).status).toBe("SUCCESS");
    expect(f.custody.receipts).toHaveLength(1);
    expect(f.custody.balance(fixtureId(MAINNET_USDG), CUSTODY)).toBe(9_904_355n);
    // Required StatusResponse fields from the official OpenAPI.
    for (const k of ["correlationId", "quoteResponse", "status", "updatedAt", "swapDetails"]) expect(done).toHaveProperty(k);
    for (const k of ["intentHashes", "nearTxHashes", "originChainTxHashes", "destinationChainTxHashes"]) expect(done.swapDetails).toHaveProperty(k);
  });

  it("answers unknown deposit addresses and bad input with the documented-style message body", () => {
    const f = makeFixture();
    expect(f.call("GET", "/v0/status?depositAddress=nope")).toMatchObject({ status: 404, body: { message: expect.any(String) } });
    expect(f.call("POST", "/v0/deposit/submit", { depositAddress: "nope" }).status).toBe(400);
    expect(f.call("POST", "/v0/quote", { dry: true }).status).toBe(400);
    expect(f.call("GET", "/v0/other").status).toBe(404);
  });
});

describe("solver failure and refund", () => {
  it("a failing solver ends FAILED, moves nothing and never credits", () => {
    const f = makeFixture("fail");
    const { depositAddress } = committedQuote(f);
    const end = runToEnd(f, depositAddress);
    expect(end.status).toBe("FAILED");
    expect(end.swapDetails.destinationChainTxHashes).toEqual([]);
    expect(f.custody.receipts).toHaveLength(0);
    for (let i = 0; i < 3; i++) expect(status(f, depositAddress).status).toBe("FAILED");
  });

  it("a refunding solver ends REFUNDED with the refund amount and reason, and a refund receipt never credits", () => {
    const f = makeFixture("refund");
    const { depositAddress } = committedQuote(f);
    const end = runToEnd(f, depositAddress);
    expect(end.status).toBe("REFUNDED");
    expect(end.swapDetails.refundedAmount).toBe("10000000");
    expect(end.swapDetails.refundReason).toMatch(/fixture/);
    expect(end.swapDetails.destinationChainTxHashes).toEqual([]);
    expect(f.custody.balance(fixtureId(MAINNET_USDC), "alice.testnet")).toBe(10_000_000n);
    expect(f.custody.balance(fixtureId(MAINNET_USDG), CUSTODY)).toBe(0n);
    const credits = new FundingCredits();
    const receipt = f.custody.receipts[0] as CustodyReceipt;
    expect(receipt.kind).toBe("refund");
    expect(credits.credit("alice.testnet", receipt)).toEqual({ credited: false, reason: "only a delivery receipt credits" });
    expect(credits.balance(receipt.assetId, "alice.testnet")).toBe(0n);
  });

  it("the mode can differ per quote and be changed between quotes", () => {
    const f = makeFixture("complete");
    const a = committedQuote(f).depositAddress;
    const b = committedQuote(f).depositAddress;
    f.solver.setModeFor(b, "refund");
    expect(runToEnd(f, a).status).toBe("SUCCESS");
    expect(runToEnd(f, b).status).toBe("REFUNDED");
    f.solver.setMode("fail");
    expect(runToEnd(f, committedQuote(f).depositAddress).status).toBe("FAILED");
  });

  it("a delivery receipt credits exactly once even when replayed", () => {
    const f = makeFixture("complete");
    const { depositAddress } = committedQuote(f);
    runToEnd(f, depositAddress);
    const receipt = f.custody.receipts[0] as CustodyReceipt;
    const credits = new FundingCredits();
    expect(credits.credit("alice.testnet", receipt).credited).toBe(true);
    expect(credits.credit("alice.testnet", { ...receipt })).toEqual({ credited: false, reason: "receipt already credited" });
    expect(credits.balance(receipt.assetId, "alice.testnet")).toBe(9_904_355n);
    // Settling the same quote again in custody returns the first receipt and moves nothing more.
    const again = f.custody.deliver({ depositAddress, assetId: receipt.assetId, to: CUSTODY, amount: 1n });
    expect(again).toBe(receipt);
    expect(f.custody.balance(receipt.assetId, CUSTODY)).toBe(9_904_355n);
  });
});

describe("fixture labels", () => {
  it("every response carries the fixture header, quote and status bodies carry the label, and logs are labelled", () => {
    const f = makeFixture("complete");
    const { depositAddress, body } = committedQuote(f);
    expect(body.valtrumFixture).toBe(FIXTURE_LABEL);
    const responses = [
      f.call("GET", "/v0/tokens"),
      f.call("GET", "/v0/nothing"),
      submit(f, depositAddress),
      f.call("GET", `/v0/status?depositAddress=${depositAddress}`),
    ];
    for (const r of responses) expect(r.headers[FIXTURE_HEADER]).toBe("true");
    expect((responses[3]!.body as Body).valtrumFixture).toBe(FIXTURE_LABEL);
    expect((responses[2]!.body as Body).valtrumFixture).toBe(FIXTURE_LABEL);
    expect(f.lines.length).toBeGreaterThan(0);
    for (const l of f.lines) expect(l).toMatchObject({ fixture: true, route: "intents-fixture", label: FIXTURE_LABEL });
  });

  it("refuses to construct outside testnet", () => {
    expect(() => makeFixtureOn("mainnet")).toThrow(/testnet/);
    expect(() => makeFixtureOn("")).toThrow(/testnet/);
  });
});

function makeFixtureOn(network: string) {
  return new IntentsFixtureService({ solver: new FakeSolver(new FixtureCustody()), network });
}
