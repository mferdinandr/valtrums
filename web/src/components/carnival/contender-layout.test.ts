import { describe, expect, it } from "vitest";
import { contenderPositions } from "./contender-layout";
import { CONTENDERS } from "../colosseum/choreography";

describe("contenderPositions", () => {
  it("gives every registered contender a finite position", () => {
    const at = contenderPositions(CONTENDERS.length);
    expect(at).toHaveLength(CONTENDERS.length);
    for (const p of at) expect(p.every(Number.isFinite)).toBe(true);
  });
  it("works for any count, including more characters than the old five hand-written spots", () => {
    for (const n of [1, 2, 5, 6, 10]) expect(contenderPositions(n)).toHaveLength(n);
  });
  it("keeps the arc symmetric with the ends low and the middle deepest", () => {
    const at = contenderPositions(5);
    expect(at[0]).toEqual([-7, 2.77, -8]);
    expect(at[2]).toEqual([0, 2.77, -16]);
    expect(at[4]).toEqual([7, 2.77, -8]);
  });
  it("returns nothing for an invalid count instead of throwing", () => {
    expect(contenderPositions(0)).toEqual([]);
    expect(contenderPositions(-1)).toEqual([]);
    expect(contenderPositions(1.5)).toEqual([]);
  });
});
