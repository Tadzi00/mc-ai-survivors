/**
 * Staircase out of a cave, planned one step at a time. PURE (no mineflayer) so it is unit-tested.
 *
 * One step in direction d from feet F: stand on the block at F+d, so clear the head room over us (F+2y)
 * and the two cells we step into (F+d+1y, F+d+2y). New feet = F+d+1y.
 */
export interface P3 {
  x: number;
  y: number;
  z: number;
}

export const STAIR_DIRS: readonly P3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

const add = (a: P3, x: number, y: number, z: number): P3 => ({ x: a.x + x, y: a.y + y, z: a.z + z });

export interface StairStep {
  /** Cells that must be empty (dug if solid), in dig order. */
  clear: P3[];
  /** Must be solid: we stand on it after the step. */
  floor: P3;
  /** Feet after the step. */
  to: P3;
  /** Cells right above the dug ones: no liquid there (it would pour in). */
  lid: P3[];
}

export function stairStep(feet: P3, d: P3): StairStep {
  const clear = [add(feet, 0, 2, 0), add(feet, d.x, 1, d.z), add(feet, d.x, 2, d.z)];
  return { clear, floor: add(feet, d.x, 0, d.z), to: add(feet, d.x, 1, d.z), lid: [add(feet, 0, 3, 0), add(feet, d.x, 3, d.z)] };
}

/** Directions to try: the last one that worked first (a straight staircase), then the rest. */
export function stairDirOrder(last?: P3): P3[] {
  if (!last) return [...STAIR_DIRS];
  return [last, ...STAIR_DIRS.filter((d) => d.x !== last.x || d.z !== last.z)];
}

/** Inside the outer walls (+ roof) of a shelter outline (as kept in memory.shelters / village buildings). */
export function inShelterBox(boxes: ReadonlyArray<{ x0: number; z0: number; x1: number; z1: number; y0: number }>, p: P3): boolean {
  return boxes.some((b) => p.x >= b.x0 && p.x <= b.x1 && p.z >= b.z0 && p.z <= b.z1 && p.y >= b.y0 - 1 && p.y <= b.y0 + 4);
}
