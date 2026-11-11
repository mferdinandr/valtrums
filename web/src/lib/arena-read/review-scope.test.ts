import { describe, expect, it, vi } from "vitest";
import { ReviewScope, reviewScopeKey, scopeWallet } from "./review-scope";
import {
  buildCreateReview,
  toActionRequest,
  type AssetDraft,
} from "./create-review";
import type { ActionWallet } from "@/lib/terminal/actions";

const assets: AssetDraft[] = [1, 2].map((i) => ({
  chainId: "46630",
  tokenAddress: `0x${String(i).repeat(40)}`,
  representation: `c${i}.rep.testnet`,
  custodyDomain: "custody-v1",
  referenceChainId: "",
  referenceAddress: "",
}));
const NOW = 1_800_000_000_000;
const START = String(NOW + 15 * 60_000);
const review = buildCreateReview("arena.testnet", assets, "PriceGain", START, NOW);
if (!review.ok) throw new Error("fixture review");
const request = toActionRequest(assets, "PriceGain", START);

describe("reviewed action scope", () => {
  it("binds exact request, transaction, wallet account and deployment rather than display labels", () => {
    const key = reviewScopeKey(
      "alice.testnet",
      "near-testnet:arena",
      request,
      review,
    );
    expect(
      reviewScopeKey(
        "alice.testnet",
        "near-testnet:arena",
        { ...request },
        { ...review, lines: [] },
      ),
    ).toBe(key);
    for (const changed of [
      reviewScopeKey("bob.testnet", "near-testnet:arena", request, review),
      reviewScopeKey("alice.testnet", "near-mainnet:arena", request, review),
      reviewScopeKey(
        "alice.testnet",
        "near-testnet:arena",
        { ...request, mode: "LowestDrawdown" },
        review,
      ),
      reviewScopeKey("alice.testnet", "near-testnet:arena", request, {
        ...review,
        receiver: "other.testnet",
      }),
      reviewScopeKey("alice.testnet", "near-testnet:arena", request, null),
    ])
      expect(changed).not.toBe(key);
  });

  it("discards a late A response even when the user changes A -> B -> A", () => {
    const scope = new ReviewScope();
    scope.select("A");
    const first = scope.begin();
    scope.select("B");
    scope.select("A");
    expect(scope.current(first)).toBe(false);
    const fresh = scope.begin();
    expect(scope.current(fresh)).toBe(true);
    scope.begin();
    expect(scope.current(fresh)).toBe(false);
  });

  it("blocks signing after an edit and blocks broadcast if details change during approval", async () => {
    const scope = new ReviewScope();
    scope.select("draft");
    const wallet: ActionWallet = {
      signMessage: vi.fn(async () => ({
        accountId: "alice.testnet",
        publicKey: "key",
        signature: "signature",
        nonce: "nonce",
      })),
      signAndSend: vi.fn(async () => "tx"),
    };
    const token = scope.begin();
    const guarded = scopeWallet(wallet, () => scope.current(token));
    await guarded.signMessage("the approved preview");
    scope.select("changed draft");
    await expect(guarded.signMessage("old preview")).rejects.toThrow(
      "details changed",
    );
    await expect(
      guarded.signAndSend({
        signerId: "alice.testnet",
        receiverId: "arena.testnet",
        actions: [],
      }),
    ).rejects.toThrow("details changed");
    expect(wallet.signMessage).toHaveBeenCalledTimes(1);
    expect(wallet.signAndSend).not.toHaveBeenCalled();
  });

  it("invalidates outstanding requests when a step is reset or unmounted", () => {
    const scope = new ReviewScope();
    const token = scope.begin();
    scope.invalidate();
    expect(scope.current(token)).toBe(false);
  });

  it("does not forward a wallet approval that finishes after the draft/account changes", async () => {
    const scope = new ReviewScope();
    scope.select("alice:original");
    const token = scope.begin();
    const wallet: ActionWallet = {
      signMessage: async () => {
        scope.select("bob:other");
        return {
          accountId: "alice.testnet",
          publicKey: "key",
          signature: "old-proof",
          nonce: "nonce",
        };
      },
      signAndSend: vi.fn(async () => "tx"),
    };
    await expect(
      scopeWallet(wallet, () => scope.current(token)).signMessage("old review"),
    ).rejects.toThrow("details changed");
    expect(wallet.signAndSend).not.toHaveBeenCalled();
  });
});
