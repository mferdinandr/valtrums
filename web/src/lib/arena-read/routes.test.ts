import { describe, expect, it } from "vitest";
import { configProblems } from "@/lib/config";
import { arenaNavigationActive } from "./routes";

describe("arena navigation", () => {
  it("is active on the list and on a lifecycle detail, not on creation or other pages", () => {
    expect(arenaNavigationActive("/arena")).toBe(true);
    expect(arenaNavigationActive("/arena/42")).toBe(true);
    for (const p of ["/arena/new", "/arena/0", "/arena/01", "/arena/1/extra", "/terminal", "/portfolio", "/"]) {
      expect(arenaNavigationActive(p)).toBe(false);
    }
  });
});

describe("required configuration", () => {
  const ok = { arenaContractId: "arena.testnet", deployment: "valtrum-testnet", protocol: "lifecycle-v2" };
  it("accepts a complete configuration", () => {
    expect(configProblems(ok)).toEqual([]);
  });
  it("names every missing variable instead of falling back to another app", () => {
    expect(configProblems({ ...ok, deployment: "" })).toEqual(["NEXT_PUBLIC_ARENA_READ_DEPLOYMENT"]);
    expect(configProblems({ ...ok, arenaContractId: "" })).toEqual(["NEXT_PUBLIC_ARENA_CONTRACT_ID"]);
    expect(configProblems({ arenaContractId: "", deployment: "", protocol: "lifecycle-v2" })).toHaveLength(2);
  });
  it("accepts only the lifecycle protocol", () => {
    expect(configProblems({ ...ok, protocol: "legacy-v1" })).toEqual(["NEXT_PUBLIC_ARENA_READ_PROTOCOL (must be lifecycle-v2)"]);
  });
});
