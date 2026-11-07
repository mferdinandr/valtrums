import { describe, expect, it } from "vitest";
import { encodeTransfer } from "../src/evm-abi.js";
import { encodeTx } from "../src/evm-tx.js";
import { isTerminalPayout, type PayoutState } from "../src/payout-status.js";

/**
 * Reference bytes shared with contracts/payout/src/evm.rs (UNSIGNED_VECTOR and
 * SIGNED_VECTOR): the contract must build exactly what the agent encodes.
 */
const UNSIGNED =
  "02f86e82210507830f424084773594008301d4c0942626664c2603336e57b271c5c0b26f421741e48180b844a9059cbb000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000000000000000000f4240c0";
const SIGNED =
  "02f8b182210507830f424084773594008301d4c0942626664c2603336e57b271c5c0b26f421741e48180b844a9059cbb000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000000000000000000f4240c001a01111111111111111111111111111111111111111111111111111111111111111a02222222222222222222222222222222222222222222222222222222222222222";

const fields = {
  chainId: 8453n,
  nonce: 7n,
  maxPriorityFeePerGas: 1_000_000n,
  maxFeePerGas: 2_000_000_000n,
  gasLimit: 120_000n,
  to: "0x2626664c2603336e57b271c5c0b26f421741e481",
  value: 0n,
  data: encodeTransfer("0x000000000000000000000000000000000000dead", 1_000_000n),
};

describe("payout transaction reference vectors", () => {
  it("encodes the unsigned and signed ERC-20 transfer exactly as the contract does", () => {
    expect(encodeTx(fields)).toBe(UNSIGNED);
    const signature = { yParity: 1, r: new Uint8Array(32).fill(0x11), s: new Uint8Array(32).fill(0x22) };
    expect(encodeTx(fields, signature)).toBe(SIGNED);
  });
});

describe("payout status types", () => {
  it("treats only confirmed and restored as terminal", () => {
    const states: PayoutState[] = [
      "authorized",
      "signing_requested",
      "signed",
      "broadcast",
      "pending_finality",
      "reverted",
      "reconciliation_required",
      "confirmed",
      "restored",
    ];
    expect(states.filter(isTerminalPayout)).toEqual(["confirmed", "restored"]);
  });
});
