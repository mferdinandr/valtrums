// Provider capability regression checks, not a real wallet login or browser test.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletButton } from "./wallet-button";

const context = vi.hoisted(() => ({
  application: true,
  walletEnabled: true,
  accountId: null as string | null,
  loading: false,
}));
vi.mock("@/components/providers", () => ({
  useApplicationDeployment: () =>
    context.application ? { deploymentId: "fixture" } : null,
  useActionWallet: () => (context.walletEnabled ? async () => ({}) : null),
  useWallet: () => ({
    accountId: context.accountId,
    loading: context.loading,
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));
const render = () => renderToStaticMarkup(createElement(WalletButton));
beforeEach(() => {
  context.application = true;
  context.walletEnabled = true;
  context.accountId = null;
  context.loading = false;
});

describe("header wallet capability", () => {
  it("offers normal wallet connection in a wallet-enabled application deployment", () => {
    const html = render();
    expect(html).toContain("Connect wallet");
    expect(html).not.toContain("Read only");
  });
  it("shows the actual connected account and disconnect rather than Read only", () => {
    context.accountId = "alice.testnet";
    const html = render();
    expect(html).toContain("alice.testnet");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("Connect wallet");
    expect(html).not.toContain("Read only");
  });
  it("retains read-only labeling only when application wallet access is disabled", () => {
    context.walletEnabled = false;
    expect(render()).toContain("Read only");
    expect(render()).not.toContain("Connect wallet");
  });
  it("keeps loading and legacy wallet states usable without the action-wallet bridge", () => {
    context.loading = true;
    expect(render()).toContain("Loading wallet");
    context.loading = false;
    context.application = false;
    context.walletEnabled = false;
    expect(render()).toContain("Connect wallet");
    context.accountId = "legacy.testnet";
    expect(render()).toContain("Disconnect");
  });
});
