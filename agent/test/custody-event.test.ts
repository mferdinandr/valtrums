import { describe, expect, it } from "vitest";
import { decodeCustodyDeposit, type CustodyLog } from "../src/custody-event.js";
import { keccakHex } from "../src/evm-abi.js";

const custody = "0x0000000000000000000000000000000000000123";
const token = "0x00000000000000000000000000000000000000ab";
const sender = "0x00000000000000000000000000000000000000cd";
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressTopic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
function fixture(): CustodyLog {
  const beneficiary = Buffer.from("alice.testnet", "utf8").toString("hex");
  return {
    address: custody,
    topics: [keccakHex("Deposited(uint256,address,address,uint64,uint64,string,uint256,uint256)"), `0x${word(1n)}`, addressTopic(token), addressTopic(sender)],
    data: `0x${word(7n)}${word(3n)}${word(160n)}${word(100n)}${word(98n)}${word(13n)}${beneficiary.padEnd(64, "0")}`,
  };
}

describe("custody deposit event decoder", () => {
  it("binds emitter, token, sender, beneficiary, version and actual amount", () => {
    expect(decodeCustodyDeposit(fixture(), custody)).toEqual({ depositId: 1n, token, depositor: sender, battleId: 7n, mappingVersion: 3n, beneficiary: "alice.testnet", requested: 100n, received: 98n });
  });
  it("rejects removed, wrong-source, malformed and overcredited events", () => {
    const log = fixture();
    expect(() => decodeCustodyDeposit({ ...log, removed: true }, custody)).toThrow();
    expect(() => decodeCustodyDeposit(log, token)).toThrow();
    expect(() => decodeCustodyDeposit({ ...log, topics: [log.topics[0]!, log.topics[1]!, `0x${"f".repeat(64)}`, log.topics[3]!] }, custody)).toThrow();
    expect(() => decodeCustodyDeposit({ ...log, data: log.data.slice(0, -2) }, custody)).toThrow();
    expect(() => decodeCustodyDeposit({ ...log, data: log.data.replace(word(98n), word(101n)) }, custody)).toThrow();
  });
});
