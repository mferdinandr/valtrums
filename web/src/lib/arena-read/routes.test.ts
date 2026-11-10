import { describe, expect, it } from "vitest";
import {
  arenaNavigationActive,
  createBattlePath,
  isApplicationRoute,
} from "./routes";

describe("application mode routes", () => {
  it("links lifecycle Create into the allowed route and activates Arena on detail without activating it on creation", () => {
    expect(isApplicationRoute(createBattlePath(true))).toBe(true);
    expect(createBattlePath(false)).toBe("/battles/new");
    expect(arenaNavigationActive("/arena/42")).toBe(true);
    expect(arenaNavigationActive("/battles/42")).toBe(true);
    expect(arenaNavigationActive("/arena/new")).toBe(false);
    expect(arenaNavigationActive("/battles/new")).toBe(false);
  });
  it("allows the landing page, the list, the lifecycle detail by decimal id and the review page", () => {
    for (const p of [
      "/",
      "/arena",
      "/arena/new",
      "/arena/1",
      "/arena/18446744073709551615",
    ])
      expect(isApplicationRoute(p)).toBe(true);
  });
  it("refuses the legacy flow, other pages and malformed ids", () => {
    for (const p of [
      "/battles/1",
      "/battles/new",
      "/terminal",
      "/portfolio",
      "/arena/preview",
      "/arena/0",
      "/arena/01",
      "/arena/1/extra",
      "/arena/-1",
      "/arena/1.5",
      "/arena/",
      null,
    ]) {
      expect(isApplicationRoute(p as string | null)).toBe(false);
    }
  });
});
