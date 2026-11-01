// Room plans: what the inside of the room the bot stands in looks like (walls, door, furniture, free floor),
// so the model can place things sensibly, and the "keep the doorway clear" rule every placement obeys.
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { isEmptyCell, v3, type Vec3 } from './helpers.js';

/** Things that stand inside a room (not walls). */
const FURNITURE = /_bed$|crafting_table|chest|barrel|furnace|smoker|torch|lantern|campfire|anvil|_carpet$|cauldron|lectern|bookshelf|_sign$|flower_pot|_banner$/;
const isDoor = (b: Block | null | undefined): boolean => !!b && b.name.endsWith('_door');

export interface RoomInfo {
  y: number;
  cells: Vec3[];
  doors: Vec3[];
  furniture: Array<{ name: string; pos: Vec3 }>;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const key = (p: { x: number; z: number }): string => `${p.x},${p.z}`;

/**
 * Flood fill of the floor level the bot stands on, bounded by walls; doors are boundaries. Undefined when the
 * spot is outdoors (a cell under open sky) or the area is too big to be a room.
 */
export function scanRoom(bot: Bot, start: Vec3, maxCells = 120): RoomInfo | undefined {
  const y = start.y;
  const seen = new Set<string>([key(start)]);
  const queue: Vec3[] = [start];
  const cells: Vec3[] = [];
  const doors: Vec3[] = [];
  const furniture: RoomInfo['furniture'] = [];
  while (queue.length) {
    const c = queue.shift()!;
    const feet = bot.blockAt(c);
    if (!feet) return undefined; // unloaded
    if (!hasRoof(bot, c)) return undefined; // open sky: not a room (block check: light data lags behind new blocks)
    cells.push(c);
    if (FURNITURE.test(feet.name)) furniture.push({ name: feet.name, pos: c });
    if (cells.length > maxCells) return undefined;
    for (const d of [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1)]) {
      const n = c.plus(d);
      if (seen.has(key(n))) continue;
      seen.add(key(n));
      const b = bot.blockAt(n);
      if (isDoor(b) || isDoor(bot.blockAt(n.offset(0, 1, 0)))) {
        doors.push(isDoor(b) ? n : n.offset(0, 1, 0));
        continue;
      }
      if (b && b.boundingBox === 'block' && !FURNITURE.test(b.name)) continue; // wall
      queue.push(n);
    }
  }
  const xs = cells.map((c) => c.x), zs = cells.map((c) => c.z);
  return { y, cells, doors, furniture, x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) };
}

/** Some solid-ish block within 6 above the floor cell (a roof). Light levels are not used: the client's
 *  sky light is not updated for freshly placed blocks, so a just-built shelter looked like open sky. */
function hasRoof(bot: Bot, c: Vec3): boolean {
  for (let dy = 2; dy <= 6; dy++) {
    const b = bot.blockAt(c.offset(0, dy, 0));
    if (!b) return true; // unloaded/out of world: don't call it sky
    if (b.boundingBox === 'block' || /_slab$|_stairs$|leaves/.test(b.name)) return true;
  }
  return false;
}

/** A spot that must stay free so the door can be used: the door itself and the cells right in front/behind. */
export function isKeepClear(bot: Bot, p: Vec3): boolean {
  for (const d of [v3(0, 0, 0), v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1)]) {
    const q = p.plus(d);
    if (isDoor(bot.blockAt(q)) || isDoor(bot.blockAt(q.offset(0, -1, 0)))) return true;
  }
  return false;
}

/** Solid horizontal neighbours (walls) around a floor cell: furniture goes against walls, not mid-room. */
export function wallsAround(bot: Bot, p: Vec3): number {
  let n = 0;
  for (const d of [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1)]) {
    const b = bot.blockAt(p.plus(d));
    if (b && b.boundingBox === 'block' && !FURNITURE.test(b.name)) n++;
  }
  return n;
}

const SYMBOL: Array<[RegExp, string]> = [
  [/_bed$/, 'B'],
  [/crafting_table/, 'T'],
  [/chest|barrel/, 'C'],
  [/furnace|smoker/, 'F'],
  [/torch|lantern|campfire/, 't'],
];

/** Free floor cells good for furniture: against a wall, not in the doorway, nearest the bot first. */
export function freeFloor(bot: Bot, room: RoomInfo): Vec3[] {
  const me = bot.entity.position.floored();
  return room.cells
    .filter((c) => {
      const b = bot.blockAt(c);
      return isEmptyCell(b) && !c.equals(me) && !isKeepClear(bot, c);
    })
    .sort((a, b) => wallsAround(bot, b) - wallsAround(bot, a) || a.distanceTo(me) - b.distanceTo(me));
}

/** ASCII top view of the room (north up), for the model. */
export function renderRoom(bot: Bot, room: RoomInfo): string {
  const me = bot.entity.position.floored();
  const inRoom = new Set(room.cells.map(key));
  const doors = new Set(room.doors.map(key));
  const lines: string[] = [];
  const width = room.x1 - room.x0 + 3;
  lines.push(`Room plan (top view, north up; x ${room.x0 - 1}..${room.x1 + 1} left->right, z ${room.z0 - 1}..${room.z1 + 1} top->bottom, floor y ${room.y}):`);
  for (let z = room.z0 - 1; z <= room.z1 + 1; z++) {
    let row = '';
    for (let x = room.x0 - 1; x <= room.x1 + 1; x++) {
      const p = v3(x, room.y, z);
      if (doors.has(key(p))) row += 'D';
      else if (!inRoom.has(key(p))) row += '#';
      else if (p.equals(me)) row += '@';
      else {
        const name = bot.blockAt(p)?.name ?? '';
        const sym = SYMBOL.find(([re]) => re.test(name))?.[1];
        row += sym ?? (isKeepClear(bot, p) ? '+' : '.');
      }
    }
    lines.push(`  ${String(z).padStart(5)} ${row}`);
  }
  void width;
  lines.push('  Legend: # wall, D door, + doorway (keep clear!), @ you, B bed, T crafting table, C chest, F furnace, t torch, . free floor.');
  const free = freeFloor(bot, room).slice(0, 4).map((c) => `${c.x},${c.y},${c.z}`);
  lines.push(`  Good free spots for furniture (against a wall, not the doorway): ${free.join('; ') || 'none - the room is full, extend_shelter'}.`);
  return lines.join('\n');
}

/** Counts of furniture inside a building footprint (for the village overview). */
export function buildingContents(bot: Bot, b: { x0: number; z0: number; x1: number; z1: number; y0: number }): string | undefined {
  const counts = new Map<string, number>();
  let loaded = false;
  for (let x = b.x0; x <= b.x1; x++) {
    for (let z = b.z0; z <= b.z1; z++) {
      for (let y = b.y0; y <= b.y0 + 2; y++) {
        const blk = bot.blockAt(v3(x, y, z));
        if (!blk) continue;
        loaded = true;
        let label = SYMBOL.find(([re]) => re.test(blk.name)) ? blk.name.replace(/^.*_bed$/, 'bed').replace(/wall_torch/, 'torch') : '';
        if (blk.name.endsWith('_bed') && (blk.getProperties() as { part?: string }).part === 'head') label = ''; // count beds once
        if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
  }
  if (!loaded) return undefined;
  return [...counts].map(([k, n]) => `${n} ${k}`).join(', ') || 'empty';
}

/**
 * Where torches go: on a wall at head height (a wall torch), not on the floor. Floor torches took the cells
 * beds need (a 3x3 room with one floor torch had no room for a second bed). Corners first, never by the door.
 */
export function wallTorchSpots(bot: Bot, room: RoomInfo): Vec3[] {
  return room.cells
    .map((c) => c.offset(0, 1, 0))
    .filter((h) => isEmptyCell(bot.blockAt(h)) && wallsAround(bot, h) >= 1 && !isKeepClear(bot, h))
    .sort((a, b) => wallsAround(bot, b) - wallsAround(bot, a));
}

/** Light sources that make a room count as a (warm) shelter. */
const LIGHT = /torch|lantern|campfire|glowstone|sea_lantern|shroomlight|jack_o_lantern/;

/**
 * Does this room count as a shelter? Walls and a roof (the room scan already needs both), headroom of at
 * least 3 blocks on every floor cell (walls at least 3 high), and a torch or other light inside. Any such
 * building counts - also one a player built - so bots can live in it and put their beds there.
 */
export function shelterCheck(bot: Bot, room: RoomInfo): { ok: boolean; why: string } {
  if (room.cells.length < 2) return { ok: false, why: 'too small' };
  const solid = (p: Vec3): boolean => {
    const b = bot.blockAt(p);
    return !!b && b.boundingBox === 'block' && !FURNITURE.test(b.name);
  };
  const low = room.cells.filter((c) => solid(c.offset(0, 1, 0)) || solid(c.offset(0, 2, 0)));
  if (low.length) return { ok: false, why: `ceiling lower than 3 blocks over ${low.length} floor cell(s)` };
  let light = false;
  for (const c of room.cells) {
    for (let dy = 0; dy <= 2 && !light; dy++) {
      const here = bot.blockAt(c.offset(0, dy, 0));
      if (here && LIGHT.test(here.name)) light = true;
      // wall torches hang on the walls next to the cell
      for (const d of [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1)]) {
        const w = bot.blockAt(c.offset(d.x, dy, d.z));
        if (w && LIGHT.test(w.name)) light = true;
      }
    }
    if (light) break;
  }
  if (!light) return { ok: false, why: 'no torch or other light inside' };
  return { ok: true, why: `${room.cells.length} floor cells, 3+ blocks high, lit${room.doors.length ? ', with a door' : ''}` };
}
