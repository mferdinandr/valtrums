import { describe, expect, it } from "vitest";
import { isApplicationRoute } from "./routes";

describe("application mode routes", () => {
  it("allows the list, the lifecycle detail by decimal id and the review page", () => {
    for (const p of ["/arena", "/arena/new", "/arena/1", "/arena/18446744073709551615"]) expect(isApplicationRoute(p)).toBe(true);
  });
  it("refuses the legacy flow, other pages and malformed ids", () => {
    for (const p of ["/", "/battles/1", "/battles/new", "/terminal", "/portfolio", "/arena/preview", "/arena/0", "/arena/01", "/arena/1/extra", "/arena/-1", "/arena/1.5", "/arena/", null]) {
      expect(isApplicationRoute(p as string | null)).toBe(false);
    }
  });
});
