import { expect, it } from "vitest";
import { inspectArenaAudit } from "../src/arena-audit.js";

it("keeps the combined audit pending while preserving all reasons", () => {
  const asset = { chainId: "46630", token: "0xabc", representation: "token.testnet", custodyDomain: "custody", mappingVersion: "1" };
  const evidence = { asset, queriedChainId: "46630", queriedToken: "0xabc", provider: "fixture", apiVersion: "v1", queriedAt: "time", policyVersion: "p", rawResponse: '{"code":1,"result":{"0xabc":{"is_honeypot":"0"}}}' };
  const result = inspectArenaAudit(asset, evidence);
  expect(result.decision).toBe("Pending");
  expect(result.findings.some((finding) => finding.field === "independent_liquidity")).toBe(true);
  expect(result.findings.some((finding) => finding.field === "approval_policy")).toBe(true);
  expect(result.findings.some((finding) => finding.field === "cannot_buy" && finding.value === null)).toBe(true);
});
