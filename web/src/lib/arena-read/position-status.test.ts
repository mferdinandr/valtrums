// FIXTURE-ONLY: synthetic battle views. Nothing here reads a chain.
import { describe, expect, it } from "vitest";
import { briefOf } from "./position-status";

describe("battle stage of a position", () => {
  it("is open before the lock and live after it", () => {
    expect(briefOf({ locked: false })).toEqual({ stage: "open", winner: null });
    expect(briefOf({ locked: true })).toEqual({ stage: "live", winner: null });
  });
  it("is finished once a final winner is recorded, with the winning community", () => {
    expect(briefOf({ locked: true, principal_community: 1 })).toEqual({ stage: "finished", winner: 1 });
    expect(briefOf({ locked: true, principal_community: 0 })).toEqual({ stage: "finished", winner: 0 });
  });
  it("is cancelled whatever else is set", () => {
    expect(briefOf({ cancelled: true, locked: false })).toEqual({ stage: "cancelled", winner: null });
  });
  it("is unknown for a battle that could not be read", () => {
    expect(briefOf(null)).toBeNull();
    expect(briefOf(undefined)).toBeNull();
  });
});
