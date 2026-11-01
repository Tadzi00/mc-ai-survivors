// One shared village for all bots (state/village.json). The first shelter founds it; every later shelter is
// built next to the existing buildings, and homes stay inside it. Pure planning helpers are unit-tested.
import path from 'node:path';
import { readJsonFile, writeJsonFile } from '../util/fsjson.js';

export interface P3 { x: number; y: number; z: number }

export interface Building {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y0: number;
  door?: P3;
  owner: string;
  at: string;
}

export interface VillageData {
  center?: P3 & { founder: string; at: string };
  buildings: Building[];
}

/** Bots farther than this from the village centre walk there before building. */
export const VILLAGE_RADIUS = 40;
/** Gap between neighbouring buildings (a path between them). */
export const BUILDING_GAP = 2;

export class Village {
  data: VillageData;
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'village.json');
    this.data = readJsonFile<VillageData>(this.file) ?? { buildings: [] };
    this.data.buildings ??= [];
  }

  get center(): P3 | undefined {
    return this.data.center;
  }

  found(p: P3, founder: string): void {
    if (this.data.center) return;
    this.data.center = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), founder, at: new Date().toISOString() };
    this.save();
  }

  addBuilding(b: Omit<Building, 'at'>): void {
    this.data.buildings = this.data.buildings.filter((o) => !(o.x0 === b.x0 && o.z0 === b.z0 && o.y0 === b.y0));
    this.data.buildings.push({ ...b, at: new Date().toISOString() });
    if (!this.data.center) this.found({ x: (b.x0 + b.x1) / 2, y: b.y0, z: (b.z0 + b.z1) / 2 }, b.owner);
    this.save();
  }

  /** The building whose footprint contains p (walls included), if any. */
  buildingAt(p: P3): Building | undefined {
    return buildingAt(this.data.buildings, p);
  }

  contains(p: P3, r = VILLAGE_RADIUS): boolean {
    const c = this.data.center;
    return !c || Math.hypot(p.x - c.x, p.z - c.z) <= r;
  }

  save(): void {
    writeJsonFile(this.file, this.data);
  }
}

export function buildingAt(list: Building[], p: P3): Building | undefined {
  return list.find((b) => p.x >= b.x0 && p.x <= b.x1 && p.z >= b.z0 && p.z <= b.z1 && p.y >= b.y0 - 1 && p.y <= b.y0 + 4);
}

/**
 * Where a new size-`s` shelter could go: next to each existing building (east/west/south/north, with a
 * BUILDING_GAP-wide path between), not overlapping any building, nearest to the village centre first.
 * Returns the new shelter's centre (feet level of the neighbour). PURE.
 */
export function plotsNextTo(buildings: Building[], s: number, center?: P3): P3[] {
  const half = Math.floor(s / 2);
  const out: P3[] = [];
  for (const b of buildings) {
    const cx = Math.floor((b.x0 + b.x1) / 2), cz = Math.floor((b.z0 + b.z1) / 2);
    const cands: P3[] = [
      { x: b.x1 + BUILDING_GAP + 1 + half, y: b.y0, z: cz },
      { x: b.x0 - BUILDING_GAP - 1 - half, y: b.y0, z: cz },
      { x: cx, y: b.y0, z: b.z1 + BUILDING_GAP + 1 + half },
      { x: cx, y: b.y0, z: b.z0 - BUILDING_GAP - 1 - half },
    ];
    for (const c of cands) {
      const nx0 = c.x - half, nz0 = c.z - half, nx1 = nx0 + s - 1, nz1 = nz0 + s - 1;
      const overlaps = buildings.some((o) => nx0 <= o.x1 + 1 && nx1 >= o.x0 - 1 && nz0 <= o.z1 + 1 && nz1 >= o.z0 - 1);
      if (!overlaps && !out.some((o) => o.x === c.x && o.z === c.z)) out.push(c);
    }
  }
  const ref = center ?? out[0];
  return ref ? out.sort((a, b) => Math.hypot(a.x - ref.x, a.z - ref.z) - Math.hypot(b.x - ref.x, b.z - ref.z)) : out;
}
