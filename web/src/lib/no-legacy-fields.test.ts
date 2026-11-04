import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("account view", () => {
  it("never reads a single liquid balance field again", () => {
    // Built from parts so this file does not match its own search.
    // The per-token view method `get_liquid_balance` is fine; the bare field is not.
    const removed = new RegExp("\\b" + ["liquid", "balance"].join("_"));
    const offenders = files(join(__dirname, "..")).filter((f) => removed.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
