import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfigError } from "@/components/providers";

describe("ConfigError", () => {
  it("is one alert naming the missing variables", () => {
    const html = renderToStaticMarkup(<ConfigError missing={["NEXT_PUBLIC_ARENA_READ_DEPLOYMENT", "NEXT_PUBLIC_ARENA_CONTRACT_ID"]} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("NEXT_PUBLIC_ARENA_READ_DEPLOYMENT");
    expect(html).toContain("NEXT_PUBLIC_ARENA_CONTRACT_ID");
    expect(html).not.toMatch(/demo|legacy/i);
  });
});
