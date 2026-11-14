import { describe, expect, it } from "vitest";
import { fadeVolume, parseMusicPref } from "./background-music";

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

describe("fadeVolume", () => {
  it("starts at the source and ends at the target", () => {
    expect(fadeVolume(0, 0.22, 0, 900)).toBe(0);
    expect(fadeVolume(0, 0.22, 900, 900)).toBeCloseTo(0.22);
    expect(fadeVolume(0, 0.22, 5000, 900)).toBeCloseTo(0.22);
  });
  it("is halfway at half time and stays within 0..1", () => {
    expect(fadeVolume(0, 1, 450, 900)).toBeCloseTo(0.5);
    expect(fadeVolume(1, 0, -10, 900)).toBe(1);
  });
  it("jumps to the target with no duration", () => {
    expect(fadeVolume(0.5, 0, 0, 0)).toBe(0);
  });
});
