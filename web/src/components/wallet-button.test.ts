// Header wallet states, not a real wallet login or browser test.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletButton } from "./wallet-button";

const context = vi.hoisted(() => ({
  accountId: null as string | null,
  loading: false,
}));
vi.mock("@/components/providers", () => ({
  useWallet: () => ({
    accountId: context.accountId,
    loading: context.loading,
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));
const render = () => renderToStaticMarkup(createElement(WalletButton));
beforeEach(() => {
  context.accountId = null;
  context.loading = false;
});

describe("header wallet", () => {
  it("offers wallet connection when signed out", () => {
    const html = render();
    expect(html).toContain("Connect wallet");
    expect(html).not.toContain("Read only");
  });
  it("shows the connected account and disconnect", () => {
    context.accountId = "alice.testnet";
    const html = render();
    expect(html).toContain("alice.testnet");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("Connect wallet");
  });
  it("shows a loading state while the wallet initializes", () => {
    context.loading = true;
    expect(render()).toContain("Loading wallet");
  });
});
