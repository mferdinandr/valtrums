// FIXTURE-ONLY: a fake action gateway and a fake wallet. No real session, signature or transaction.
import { describe, expect, it, vi } from "vitest";
import { createActionWallet, ActionSession, type WalletLike } from "./action-session";
import { previewCreate } from "./create-flow";
import { buildCreateReview, CREATE_DEPOSIT_YOCTO, toActionRequest, type AssetDraft } from "./create-review";
import { executeTerminalAction } from "@/lib/terminal/actions";

const ACCOUNT = "alice.testnet";
const draft = (i: number): AssetDraft => ({ chainId: "46630", tokenAddress: `0x${String(i).repeat(40)}`, representation: `c${i}.rep.testnet`, custodyDomain: "custody-v1", referenceChainId: "", referenceAddress: "" });
const drafts = [draft(1), draft(2)];
const NOW = 1_800_000_000_000;
const START = String(NOW + 15 * 60_000);
const review = (() => { const r = buildCreateReview("arena.testnet", drafts, "PriceGain", START, NOW); if (!r.ok) throw new Error("fixture"); return r; })();

function world(over: { previewArgs?: unknown; confirm?: boolean } = {}) {
  const calls: string[] = [];
  const tx = { signerId: ACCOUNT, receiverId: "arena.testnet", actions: [{ type: "FunctionCall", methodName: "create_lifecycle_battle", args: over.previewArgs ?? review.args, gas: "100000000000000", deposit: CREATE_DEPOSIT_YOCTO }] };
  const record = (status: string) => ({ actionId: "a1", previewHash: "hash1", status, reason: null, preview: { expiresAtMs: 9e12, accountId: ACCOUNT, transaction: tx, costs: {}, binding: {} } });
  const gateway = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url, "http://x").pathname.replace("/api/arena/actions", "");
    calls.push(`${init.method} ${path || "/"}`);
    if (path === "" && init.method === "POST") return Response.json({ data: record("previewed") });
    if (path.endsWith("/authorize")) return Response.json({ data: record("authorized") });
    if (path.endsWith("/prepare")) return Response.json({ data: { record: record("ready_to_sign"), transaction: tx } });
    if (path.endsWith("/broadcast")) return Response.json({ data: record(over.confirm === false ? "broadcast" : "confirmed") });
    return Response.json({ data: record(over.confirm === false ? "broadcast" : "confirmed") });
  });
  const wallet: WalletLike = {
    signMessage: async () => ({ accountId: ACCOUNT, publicKey: "ed25519:k", signature: "c2ln" }),
    signAndSendTransaction: vi.fn(async () => ({ transaction: { hash: "TXH" } })),
  };
  const sessionFetch = async (url: string) => (url.endsWith("/config") ? Response.json({ readMessage: "m", sessionRecipient: "r", actionRecipient: "a" }) : Response.json({ token: "tok", accountId: ACCOUNT, expiresAt: new Date(2e12).toISOString() }));
  const session = new ActionSession({ accountId: ACCOUNT, wallet, fetchImpl: sessionFetch as never, now: () => 1_000_000 });
  const action = createActionWallet(session, { accountId: ACCOUNT, wallet, now: () => 1_000_000 });
  const deps = { session: "tok", wallet: action, fetchImpl: gateway as never, sleep: async () => undefined, maxPolls: 1 };
  return { calls, deps, wallet };
}
const request = toActionRequest(drafts, "PriceGain", START);

describe("create flow sequencing", () => {
  it("previews first, authorizes and signs only after the preview matches, and confirms from a verified receipt", async () => {
    const w = world();
    const outcome = await previewCreate(request, review, ACCOUNT, w.deps);
    expect(outcome.step).toBe("previewed");
    expect(w.calls).toEqual(["POST /"]); // the preview alone: no authorization, no signing
    expect(w.wallet.signAndSendTransaction).not.toHaveBeenCalled();
    if (outcome.step !== "previewed") return;
    const result = await executeTerminalAction(outcome.previewed, w.deps);
    expect(result).toMatchObject({ ok: true, status: "confirmed", txHash: "TXH" });
    expect(w.calls).toEqual(["POST /", "POST /a1/authorize", "POST /a1/prepare", "POST /a1/broadcast"]);
  });

  it("stops before any authorization when the service's preview differs from the reviewed call", async () => {
    const w = world({ previewArgs: { assets: review.args.assets, mode: "VolumeRatio" } });
    const outcome = await previewCreate(request, review, ACCOUNT, w.deps);
    expect(outcome).toMatchObject({ step: "blocked", reasons: ["the preview arguments differ from the reviewed arguments"] });
    expect(w.calls).toEqual(["POST /"]);
    expect(w.wallet.signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("a submitted transaction without a verified receipt is not reported as a created battle", async () => {
    const w = world({ confirm: false });
    const outcome = await previewCreate(request, review, ACCOUNT, w.deps);
    if (outcome.step !== "previewed") throw new Error("fixture");
    const result = await executeTerminalAction(outcome.previewed, w.deps);
    expect(result).toMatchObject({ ok: false, status: "broadcast", txHash: "TXH" });
  });

  it("a wallet rejection ends the run with an error and sends nothing", async () => {
    const w = world();
    const outcome = await previewCreate(request, review, ACCOUNT, w.deps);
    if (outcome.step !== "previewed") throw new Error("fixture");
    w.wallet.signMessage = async () => { throw new Error("user rejected"); };
    const rejecting = createActionWallet(new ActionSession({ accountId: ACCOUNT, wallet: w.wallet, fetchImpl: (async (u: string) => (u.endsWith("/config") ? Response.json({ readMessage: "m", sessionRecipient: "r", actionRecipient: "a" }) : Response.json({}))) as never }), { accountId: ACCOUNT, wallet: w.wallet });
    const result = await executeTerminalAction(outcome.previewed, { ...w.deps, wallet: rejecting });
    expect(result).toMatchObject({ ok: false, status: "error", reason: "user rejected" });
    expect(w.wallet.signAndSendTransaction).not.toHaveBeenCalled();
  });
});
