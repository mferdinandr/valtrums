import { describe, expect, it } from "vitest";
import { loopEnd, parseMusicPref } from "./background-music";

describe("parseMusicPref", () => {
  it("defaults to on", () => {
    expect(parseMusicPref(null)).toBe("on");
    expect(parseMusicPref(undefined)).toBe("on");
    expect(parseMusicPref("garbage")).toBe("on");
  });
  it("remembers off", () => {
    expect(parseMusicPref("off")).toBe("off");
  });
});

describe("loopEnd", () => {
  it("loops on the musical cycle when the decoder adds padding", () => {
    expect(loopEnd(64.05, 64)).toBe(64);
  });
  it("never points past the buffer", () => {
    expect(loopEnd(63.9, 64)).toBe(63.9);
  });
  it("is zero for an empty or invalid buffer", () => {
    expect(loopEnd(0, 64)).toBe(0);
    expect(loopEnd(Number.NaN, 64)).toBe(0);
  });
});
