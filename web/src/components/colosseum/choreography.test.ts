import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTENDERS,
  fighterPose,
  makeRuntime,
  rosterFor,
  roundAt,
  resolveScores,
  beatAt,
  challengeAt,
  homeAt,
  MODES,
  type ScoreMode,
} from "./choreography";

describe("colosseum exhibition", () => {
  it("keeps every contender pose finite across the full choreography", () => {
    for (const count of [2, 3, 5, 6])
      for (const mode of Object.keys(MODES) as ScoreMode[])
        for (let time = 0; time <= 103; time += 0.25) {
          const runtime = {
            ...makeRuntime(rosterFor(count)),
            time,
            phase: "battle" as const,
            mode,
          };
          for (let i = 0; i < count; i++) {
            const pose = fighterPose(i, runtime);
            expect(
              [pose.x, pose.z, pose.yaw, pose.travel, pose.hit].every(
                Number.isFinite,
              ),
            ).toBe(true);
          }
        }
  });
  it("advances only tied leaders, resets scores and retains eliminated participants", () => {
    const state = { ...makeRuntime(), phase: "battle" as const };
    const first = roundAt({ ...state, time: 32 });
    expect(first.stage).toBe("overtime");
    expect(first.candidates).toEqual([0, 2]);
    expect(first.eliminated).toEqual([1, 3, 4]);
    expect(roundAt({ ...state, time: 35 }).scores).toEqual([]);
    const second = roundAt({ ...state, time: 67 });
    expect(second.stage).toBe("overtime");
    expect(second.candidates).toEqual([0, 2]);
    expect(second.scores.every((s) => s.n < 0n)).toBe(true);
    expect(second.history).toHaveLength(2);
    const last = roundAt({ ...state, time: 102 });
    expect(last.winner).toBe(2);
    expect(last.history).toHaveLength(3);
    expect(last.eliminated).toEqual([0, 1, 3, 4]);
    for (let time = 35; time < 102; time += 0.3) {
      const beat = beatAt({ ...state, time });
      expect([0, 2]).toContain(beat.attacker);
      expect(beat.target.owner).toBe(beat.attacker);
    }
  });
  it("holds incomplete evidence without eliminating or awarding a default win", () => {
    const state = {
      ...makeRuntime(),
      scenario: "missing" as const,
      time: 10000,
    };
    const held = roundAt(state);
    expect(held.stage).toBe("pending");
    expect(held.winner).toBeNull();
    expect(held.eliminated).toEqual([]);
    expect(held.history).toEqual([]);
    expect(roundAt({ ...state, time: 32, evidenceReady: true }).stage).toBe(
      "overtime",
    );
  });
  it("compares exact signed rational scores and reverses only drawdown ordering", () => {
    const scores = [
      { participant: 0, n: -4n, d: 100n },
      { participant: 1, n: -5n, d: 100n },
    ];
    expect(resolveScores(scores, "gain")).toEqual([0]);
    expect(
      resolveScores(
        [
          { participant: 0, n: 1n, d: 3n },
          { participant: 1, n: 2n, d: 6n },
        ],
        "volume",
      ),
    ).toEqual([0, 1]);
    expect(
      resolveScores(
        [
          { participant: 0, n: 2n, d: 100n },
          { participant: 1, n: 1n, d: 100n },
        ],
        "drawdown",
      ),
    ).toEqual([1]);
    expect(() =>
      resolveScores([{ participant: 0, n: 1n, d: 0n }], "gain"),
    ).toThrow();
  });
  it("resolves all modes and roster sizes and keeps the sixth slot explicitly synthetic", () => {
    for (const count of [2, 3, 5, 6])
      for (const mode of Object.keys(MODES) as ScoreMode[]) {
        const state = { ...makeRuntime(rosterFor(count)), mode, time: 102 };
        expect(roundAt(state).winner).toBe(count > 2 ? 2 : 0);
      }
    expect(rosterFor(6)[5]).toMatchObject({
      synthetic: true,
      demoTokenId: "",
      referenceAddress: "",
    });
    expect(
      roundAt({ ...makeRuntime(), scenario: "clean", time: 32 }).history,
    ).toHaveLength(1);
  });
  it("keeps ratio/drawdown evidence nonnegative and lets every initial contender attack", () => {
    for (const mode of ["volume", "drawdown"] as const) {
      for (const time of [32, 67, 102]) {
        const result = roundAt({ ...makeRuntime(), mode, time });
        expect(result.scores.every((score) => score.n >= 0n)).toBe(true);
      }
      expect(() =>
        resolveScores([{ participant: 0, n: -1n, d: 100n }], mode),
      ).toThrow();
    }
    const attackers = new Set<number>();
    for (let time = 0; time < 30; time += 0.5)
      attackers.add(
        beatAt({ ...makeRuntime(), phase: "battle", time }).attacker,
      );
    expect([...attackers].sort()).toEqual([0, 1, 2, 3, 4]);
  });
  it("targets only personal arena stations and never applies damage to a rival", () => {
    for (const count of [2, 3, 5, 6])
      for (let time = 0; time < 30; time += 0.2) {
        const state = {
          ...makeRuntime(rosterFor(count)),
          phase: "battle" as const,
          time,
        };
        const beat = beatAt(state);
        expect(beat.target).toEqual(challengeAt(beat.attacker, count));
        for (let i = 0; i < count; i++) {
          expect(fighterPose(i, state).hit).toBe(0);
          const [x, z] = homeAt(i, count);
          expect(
            Math.hypot(beat.target.x - x, beat.target.z - z),
          ).toBeGreaterThan(1.5);
        }
      }
  });
  it("keeps fixture scores independent of animation, selection and camera", () => {
    const state = { ...makeRuntime(), time: 102 };
    expect(
      roundAt({ ...state, reduced: true, selected: 4, camera: "follow" }),
    ).toEqual(roundAt(state));
  });
  it("ships self-contained GLBs with actual animation tracks and correct source identity", () => {
    const research = readFileSync(
      join(process.cwd(), "../docs/findings-and-decisions.md"),
      "utf8",
    ).toLowerCase();
    for (const contender of CONTENDERS) {
      expect(contender.referenceAddress).toMatch(/^0x[0-9a-f]{40}$/);
      expect(research).toContain(contender.referenceAddress);
      const data = readFileSync(
        join(process.cwd(), `public/models/colosseum/${contender.asset}.glb`),
      );
      expect(data.readUInt32LE(0)).toBe(0x46546c67);
      expect(data.readUInt32LE(8)).toBe(data.length);
      const json = JSON.parse(
        data.subarray(20, 20 + data.readUInt32LE(12)).toString(),
      );
      expect(json.animations.map((a: { name: string }) => a.name)).toEqual(
        expect.arrayContaining([
          "Idle",
          "Attack",
          "Selected",
          "Victory",
          "Defeat",
        ]),
      );
      expect(json.buffers.every((b: { uri?: string }) => !b.uri)).toBe(true);
      expect(
        json.nodes.some(
          (n: { extras?: { tokenIdentity?: { referenceAddress?: string } } }) =>
            n.extras?.tokenIdentity?.referenceAddress ===
            contender.referenceAddress,
        ),
      ).toBe(true);
    }
  });
});
