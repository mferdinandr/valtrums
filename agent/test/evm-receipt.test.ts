import { describe, expect, it } from "vitest";
import { TRANSFER_TOPIC } from "../src/evm-abi.js";
import { receivedAmount } from "../src/evm-receipt.js";
import type { EvmReceipt } from "../src/evm-rpc.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const COIN = "0x4200000000000000000000000000000000000006";
const WALLET = "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B";
const OTHER = "0x1111111111111111111111111111111111111111";

const pad = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}`;
const amountData = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const transfer = (token: string, from: string, to: string, n: bigint) => ({
  address: token.toLowerCase(), // nodes return lowercase addresses
  topics: [TRANSFER_TOPIC, pad(from), pad(to)],
  data: amountData(n),
});

const receipt = (logs: EvmReceipt["logs"]): EvmReceipt => ({
  transactionHash: "0xabc",
  status: true,
  blockNumber: 1n,
  logs,
});

describe("receivedAmount", () => {
  it("sums Transfer logs of the token to the recipient", () => {
    const r = receipt([
      transfer(COIN, WALLET, OTHER, 1_000_000_000_000_000_000n), // input leg
      transfer(USDC, OTHER, WALLET, 123_456_789n),
      transfer(USDC, OTHER, WALLET, 11n),
    ]);
    expect(receivedAmount(r, USDC, WALLET)).toBe(123_456_800n);
    expect(receivedAmount(r, COIN, WALLET)).toBe(0n);
    expect(receivedAmount(r, COIN, OTHER)).toBe(1_000_000_000_000_000_000n);
  });

  it("matches addresses case-insensitively", () => {
    const r = receipt([transfer(USDC, OTHER, WALLET, 5n)]);
    expect(receivedAmount(r, USDC.toUpperCase().replace("0X", "0x"), WALLET.toLowerCase())).toBe(5n);
  });

  it("ignores other events, other emitters and four-topic (NFT) transfers", () => {
    const nft = { ...transfer(USDC, OTHER, WALLET, 0n), topics: [TRANSFER_TOPIC, pad(OTHER), pad(WALLET), amountData(9n)], data: "0x" };
    const approval = { ...transfer(USDC, OTHER, WALLET, 7n), topics: [`0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925`, pad(OTHER), pad(WALLET)] };
    const r = receipt([nft, approval, transfer(COIN, OTHER, WALLET, 3n)]);
    expect(receivedAmount(r, USDC, WALLET)).toBe(0n);
  });

  it("rejects a malformed amount", () => {
    const bad = { ...transfer(USDC, OTHER, WALLET, 1n), data: "0x01" };
    expect(() => receivedAmount(receipt([bad]), USDC, WALLET)).toThrow("malformed");
  });
});
