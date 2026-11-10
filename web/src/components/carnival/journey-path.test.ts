import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAPTERS,
  chapterAt,
  chapterOpacity,
  hostPosition,
  journeyFrame,
  journeyProgress,
  settleProgress,
} from "./journey-path";

describe("landing scroll journey", () => {
  it("maps native scroll to bounded reversible progress", () => {
    expect(journeyProgress(0, 4000, 1000)).toBe(0);
    expect(journeyProgress(-1500, 4000, 1000)).toBe(0.5);
    expect(journeyProgress(-3000, 4000, 1000)).toBe(1);
    expect(journeyProgress(100, 4000, 1000)).toBe(0);
    expect(journeyProgress(-5000, 4000, 1000)).toBe(1);
    expect(journeyProgress(0, 1000, 1000)).toBe(0);
    expect(journeyFrame(0.6)).toEqual(
      journeyFrame(journeyProgress(-1800, 4000, 1000)),
    );
  });
  it("keeps cameras above terrain and within the open gate corridor", () => {
    for (const mobile of [false, true])
      for (let p = 0; p <= 1; p += 0.002) {
        const frame = journeyFrame(p, mobile);
        expect(
          [...frame.camera, ...frame.look, frame.gateOpen].every(
            Number.isFinite,
          ),
        ).toBe(true);
        expect(frame.camera[1]).toBeGreaterThan(4);
        expect(frame.gateOpen).toBeGreaterThanOrEqual(0);
        expect(frame.gateOpen).toBeLessThanOrEqual(1);
        if (p < 0.3 && frame.camera[2] >= 5.5 && frame.camera[2] <= 6.5) {
          expect(Math.abs(frame.camera[0])).toBeLessThan(4.5);
          expect(frame.gateOpen).toBe(1);
        }
      }
    expect(journeyFrame(0).gateOpen).toBe(0);
    expect(journeyFrame(1).gateOpen).toBe(1);
    expect(journeyFrame(1).camera[1]).toBeGreaterThan(12);
    expect(journeyFrame(1).look[2]).toBeLessThan(-5);
  });
  it("gives reduced motion one stable vista and maps chapter destinations correctly", () => {
    expect(journeyFrame(0, true, true)).toEqual(journeyFrame(1, true, true));
    CHAPTERS.forEach((chapter, i) => {
      expect(chapterAt(chapter.at)).toBe(i);
      expect(chapterOpacity(chapter.at, i)).toBeGreaterThan(0);
    });
    expect(chapterOpacity(0, 0)).toBe(1);
    expect(chapterOpacity(1, CHAPTERS.length - 1)).toBe(1);
    for (let p = 0; p <= 1; p += 0.005)
      for (let i = 0; i < CHAPTERS.length; i++) {
        const opacity = chapterOpacity(p, i);
        expect(opacity).toBeGreaterThanOrEqual(0);
        expect(opacity).toBeLessThanOrEqual(1);
        if (i !== chapterAt(p)) expect(opacity).toBe(0);
      }
  });
  it("keeps travel velocity continuous and deliberately holds at the overlooks", () => {
    const epsilon = 0.00001;
    for (const p of [
      0.15, 0.25, 0.3, 0.35, 0.45, 0.49, 0.56, 0.63, 0.69, 0.75, 0.8, 0.85,
    ]) {
      for (const key of ["camera", "look"] as const) {
        const before = journeyFrame(p - epsilon)[key],
          at = journeyFrame(p)[key],
          after = journeyFrame(p + epsilon)[key];
        for (let axis = 0; axis < 3; axis++) {
          const incoming = (at[axis]! - before[axis]!) / epsilon;
          const outgoing = (after[axis]! - at[axis]!) / epsilon;
          expect(Math.abs(incoming - outgoing)).toBeLessThan(0.1);
        }
      }
    }
    expect(journeyFrame(0.31).camera).toEqual(journeyFrame(0.34).camera);
    expect(journeyFrame(0.46).camera).toEqual(journeyFrame(0.48).camera);
    expect(journeyFrame(0.64).camera).toEqual(journeyFrame(0.68).camera);
    expect(journeyFrame(0.81).camera).toEqual(journeyFrame(0.84).camera);
    expect(journeyFrame(0.2).camera[2]).toBeGreaterThan(
      journeyFrame(0.201).camera[2],
    );
  });
  it("routes each host reversibly without crossing the central hub or sharing a reactor", () => {
    for (let p = 0; p <= 1; p += 0.002) {
      for (let i = 0; i < 5; i++)
        expect(hostPosition(i, p).every(Number.isFinite)).toBe(true);
      for (const i of [0, 4]) {
        const [x, , z] = hostPosition(i, p);
        expect(Math.hypot(x, z + 8)).toBeGreaterThan(1.8);
      }
      const [x, , z] = hostPosition(3, p);
      // Keep the receipt host out of the back-left community counter.
      expect(Math.hypot(x + 5, z + 14)).toBeGreaterThan(2);
    }
    expect(hostPosition(0, 0.65)).not.toEqual(hostPosition(4, 0.65));
    for (let i = 0; i < 5; i++)
      expect(hostPosition(i, 0.32)).toEqual(
        hostPosition(i, journeyProgress(-960, 4000, 1000)),
      );
  });
  it("damps wheel steps without overshoot, settles and reverses at different frame rates", () => {
    for (const fps of [30, 60, 120]) {
      let p = 0;
      for (let frame = 0; frame < fps; frame++) {
        const next = settleProgress(p, 0.8, 1 / fps);
        expect(next).toBeGreaterThanOrEqual(p);
        expect(next).toBeLessThanOrEqual(0.8);
        p = next;
      }
      expect(p).toBeCloseTo(0.8, 3);
      for (let frame = 0; frame < fps * 2; frame++)
        p = settleProgress(p, 0.2, 1 / fps);
      expect(p).toBe(0.2);
    }
  });
  it("ships a self-contained world with independent door hinges and bounded asset cost", () => {
    const data = readFileSync(
      join(process.cwd(), "public/models/carnival/landing-world.glb"),
    );
    expect(data.readUInt32LE(0)).toBe(0x46546c67);
    expect(data.readUInt32LE(8)).toBe(data.length);
    expect(data.length).toBeLessThan(2_500_000);
    const gltf = JSON.parse(
      data.subarray(20, 20 + data.readUInt32LE(12)).toString(),
    );
    expect(gltf.buffers.every((b: { uri?: string }) => !b.uri)).toBe(true);
    expect(gltf.nodes.map((n: { name?: string }) => n.name)).toEqual(
      expect.arrayContaining([
        "GateLeft",
        "GateRight",
        "CommunityPlaza",
        "EventBoard",
        "FestivalBalloons",
        "ArrivalPath",
        "ArenaOverlook",
        "OverlookReactorHead0",
        "OverlookReactorHead1",
      ]),
    );
    const doorIndices = ["GateLeft", "GateRight"].map((name) =>
      gltf.nodes.findIndex((n: { name?: string }) => n.name === name),
    );
    expect(doorIndices[0]).not.toBe(doorIndices[1]);
    for (const index of doorIndices)
      expect(gltf.nodes[index].children.length).toBeGreaterThan(0);
  });
  it("ships independent detailed zones with movable mechanisms and local buffers", () => {
    const zones = [
      [
        "landing-foundry.glb",
        [
          "LivingFoundry",
          "FoundryArm",
          "FoundryWheel",
          "FoundryCapsuleA",
          "FoundryCapsuleB",
          "FoundryTicket",
        ],
      ],
      [
        "landing-vault.glb",
        [
          "LivingVault",
          "VaultDoor",
          "VaultHandle",
          "VaultClaimDrawer",
          "VaultWithdrawDrawer",
        ],
      ],
    ] as const;
    let total = 0;
    for (const [asset, names] of zones) {
      const data = readFileSync(
        join(process.cwd(), "public/models/carnival", asset),
      );
      expect(data.readUInt32LE(0)).toBe(0x46546c67);
      expect(data.readUInt32LE(8)).toBe(data.length);
      expect(data.length).toBeLessThan(700_000);
      total += data.length;
      const gltf = JSON.parse(
        data.subarray(20, 20 + data.readUInt32LE(12)).toString(),
      );
      expect(
        gltf.buffers.every((buffer: { uri?: string }) => !buffer.uri),
      ).toBe(true);
      expect(gltf.meshes.length).toBeLessThan(35);
      expect(gltf.nodes.map((node: { name?: string }) => node.name)).toEqual(
        expect.arrayContaining([...names]),
      );
      for (const name of names.slice(1))
        expect(
          gltf.nodes.find((node: { name?: string }) => node.name === name)
            .children.length,
        ).toBeGreaterThan(0);
    }
    expect(total).toBeLessThan(1_000_000);
  });
});
