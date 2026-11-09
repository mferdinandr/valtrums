// FIXTURE EVIDENCE harness: binds user action, preview, authorization, funding route status and the
// custody receipt in one trace. Everything runs against the fixture, fake solver, in-memory custody and
// scripted receipts. It is not live evidence and proves no NEAR Intents integration.
import { sha256Hex } from "../../src/mcp/actions/canonical.js";
import { FixtureCustody, FundingCredits, receiptKey } from "../../src/intents-fixture/custody.js";
import { FIXTURE_LABEL } from "../../src/intents-fixture/label.js";
import { IntentsFixtureService, TERMINAL_STATUSES } from "../../src/intents-fixture/service.js";
import { FakeSolver, type SolverMode } from "../../src/intents-fixture/solver.js";
import { NOW } from "../mcp/fixtures.js";
import { REP, baseCtx, deposit, key, makeActions, signFor } from "./harness.js";
import { fixtureId, recording } from "./helpers.js";

const ORIGIN = recording.dryQuotes.near_usdc_to_hood_usdg!.request.originAsset as string;
const DEST = recording.dryQuotes.near_usdc_to_hood_usdg!.request.destinationAsset as string;
const CUSTODY_BENEFICIARY = "0x2222222222222222222222222222222222222222";

type J = Record<string, any>;

export async function runFundedTrace(mode: SolverMode = "complete"): Promise<J> {
  const custody = new FixtureCustody();
  const service = new IntentsFixtureService({ solver: new FakeSolver(custody, mode), network: "testnet", now: () => NOW });
  const call = (method: string, url: string, body?: unknown) => service.handle({ method, url, ...(body !== undefined ? { body } : {}) }).body as J;
  const user = "alice.testnet";

  // 1. Quote: dry preview, then the committed quote that issues the deposit address.
  const request = {
    swapType: "EXACT_INPUT",
    originAsset: fixtureId(ORIGIN),
    destinationAsset: fixtureId(DEST),
    amount: "10000000",
    slippageTolerance: 100,
    recipient: CUSTODY_BENEFICIARY,
    refundTo: user,
  };
  const dry = call("POST", "/v0/quote", { ...request, dry: true });
  const wet = call("POST", "/v0/quote", { ...request, dry: false });
  const depositAddress: string = wet.quote.depositAddress;

  // 2. The user "sends" the origin mock token (simulated) and reports it; poll to a terminal status.
  const routeStatuses: string[] = ["PENDING_DEPOSIT"];
  const submitted = call("POST", "/v0/deposit/submit", { txHash: "fixture-origin-deposit-tx", depositAddress });
  routeStatuses.push(submitted.status);
  let last = submitted;
  for (let i = 0; i < 6 && !TERMINAL_STATUSES.includes(last.status); i++) {
    last = call("GET", `/v0/status?depositAddress=${depositAddress}`);
    routeStatuses.push(last.status);
  }

  // 3. The arena credits a delivery receipt once, keyed by its identity.
  const credits = new FundingCredits();
  const receipt = custody.receipts[0] ?? null;
  const credit = receipt ? credits.credit(user, receipt) : { credited: false, reason: "no receipt" };
  const replay = receipt ? credits.credit(user, { ...receipt }) : null;
  const credited = credits.balance(fixtureId(DEST), user);

  // 4. The user action: preview -> NEP-413 authorization -> prepare -> broadcast -> verified receipt.
  const { service: actions, source, receipts } = makeActions({ ...baseCtx, intentsFixture: true }, 0n);
  source.data.balances!.set(key(REP, user), credited);
  const actionStatuses: string[] = [];
  let action: J | null = null;
  if (credited > 0n) {
    const previewed = await actions.preview(user, deposit({ route: "intents-fixture", amount: credited.toString() }));
    actionStatuses.push(previewed.status);
    const authorized = await actions.authorize(previewed.actionId, user, signFor(previewed.previewHash));
    actionStatuses.push(authorized.status);
    const prepared = await actions.prepare(previewed.actionId, user);
    actionStatuses.push(prepared.record.status);
    const broadcast = await actions.reportBroadcast(previewed.actionId, user, "8".repeat(44));
    actionStatuses.push(broadcast.status);
    receipts.next = { status: "success" };
    const confirmed = await actions.refresh(previewed.actionId, user);
    actionStatuses.push(confirmed.status);
    const attribution = await actions.attribution(previewed.actionId, user);
    action = {
      actionId: previewed.actionId,
      previewHash: previewed.previewHash,
      bindingHash: previewed.bindingHash,
      kind: previewed.preview.kind,
      amount: credited.toString(),
      route: attribution.route,
      authorization: { kind: confirmed.authorization?.kind, accountId: user },
      finalStatus: confirmed.status,
      limitationsLabelled: previewed.preview.limitations.includes(FIXTURE_LABEL),
    };
  }

  const binding = receipt && action ? sha256Hex(JSON.stringify([action.actionId, action.previewHash, wet.correlationId, receiptKey(receipt)])) : null;
  return {
    label: "FIXTURE EVIDENCE: produced by the local 1Click fixture, the fake solver, in-memory custody and scripted receipts. Not a NEAR Intents integration and not a live trace.",
    fixtureLabel: FIXTURE_LABEL,
    solverMode: mode,
    fundingQuote: {
      correlationId: wet.correlationId,
      dryAmountOut: dry.quote.amountOut,
      amountIn: wet.quote.amountIn,
      amountOut: wet.quote.amountOut,
      minAmountOut: wet.quote.minAmountOut,
      depositAddress,
      recipient: CUSTODY_BENEFICIARY,
      refundTo: user,
    },
    routeStatuses,
    finalRouteStatus: last.status,
    custodyReceipt: receipt,
    credit: { first: credit, replay, creditedAmount: credited.toString() },
    actionStatuses,
    action,
    bindingDigest: binding,
  };
}
