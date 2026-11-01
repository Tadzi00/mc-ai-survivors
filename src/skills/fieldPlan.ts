// Where a field can go (PURE, unit-tested). Farmland only stays wet within 4 blocks (horizontally) of water
// at the same height; without a bucket the field has to be built next to existing water.

export interface P3 { x: number; y: number; z: number }

/** Soil cells that a given water block keeps wet: same y, within 4 blocks on x and z. */
export function wetTiles(water: P3, soil: readonly P3[]): P3[] {
  return soil.filter((s) => s.y === water.y && Math.abs(s.x - water.x) <= 4 && Math.abs(s.z - water.z) <= 4);
}

/**
 * The best water block for a field: the most dry-land soil it can water (at least `min`), nearest to
 * `center` on ties. Returns the water block and its tiles (nearest to the water first).
 */
export function bestFieldSite(waters: readonly P3[], soil: readonly P3[], center: P3, min = 6): { water: P3; tiles: P3[] } | undefined {
  let best: { water: P3; tiles: P3[]; score: number } | undefined;
  for (const w of waters) {
    const tiles = wetTiles(w, soil);
    if (tiles.length < min) continue;
    const score = Math.min(tiles.length, 40) * 10 - Math.hypot(w.x - center.x, w.z - center.z);
    if (!best || score > best.score) best = { water: w, tiles, score };
  }
  if (!best) return undefined;
  const w = best.water;
  return { water: w, tiles: [...best.tiles].sort((a, b) => Math.hypot(a.x - w.x, a.z - w.z) - Math.hypot(b.x - w.x, b.z - w.z)) };
}
