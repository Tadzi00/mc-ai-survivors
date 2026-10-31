import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Item } from 'prismarine-item';
import pathfinderPkg from 'mineflayer-pathfinder';
import vec3 from 'vec3';
import { AbortError, sleep, throwIfAborted, withTimeout } from '../util/time.js';
import type { SkillContext } from './context.js';

const { goals } = pathfinderPkg;
export type Vec3 = InstanceType<typeof vec3.Vec3>;
export const v3 = (x: number, y: number, z: number): Vec3 => new vec3.Vec3(x, y, z);

export const HOSTILE_MOBS = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider', 'cave_spider', 'witch', 'slime',
  'phantom', 'enderman', 'pillager', 'vindicator', 'zombie_villager', 'silverfish', 'bogged', 'breeze',
]);

export const BUILDING_BLOCK_RE =
  /(_planks|^cobblestone$|^cobbled_deepslate$|^dirt$|^stone$|^stone_bricks$|^bricks$|^sandstone$|^andesite$|^diorite$|^granite$|^deepslate$|^tuff$|^mud_bricks$|^blackstone$|^netherrack$|_log$|^glass$)/;

/** Count of an item by exact name, or by regex. */
export function countItem(bot: Bot, name: string | RegExp): number {
  return bot.inventory
    .items()
    .filter((i) => (typeof name === 'string' ? i.name === name : name.test(i.name)))
    .reduce((n, i) => n + i.count, 0);
}

export function findItem(bot: Bot, name: string | RegExp): Item | undefined {
  return bot.inventory.items().find((i) => (typeof name === 'string' ? i.name === name : name.test(i.name)));
}

/**
 * Resolves a friendly block query to concrete block names: exact name, aliases ("log"/"wood" →
 * every *_log, "ore" → every *_ore), or substring match.
 */
export function resolveBlockNames(bot: Bot, query: string): string[] {
  const q = query.toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');
  const all = Object.keys(bot.registry.blocksByName);
  const alias: Record<string, (n: string) => boolean> = {
    log: (n) => n.endsWith('_log') && !n.startsWith('stripped_'),
    logs: (n) => n.endsWith('_log') && !n.startsWith('stripped_'),
    wood: (n) => n.endsWith('_log') && !n.startsWith('stripped_'),
    tree: (n) => n.endsWith('_log') && !n.startsWith('stripped_'),
    stone: (n) => n === 'stone' || n === 'cobblestone',
    cobblestone: (n) => n === 'stone' || n === 'cobblestone',
    ore: (n) => n.endsWith('_ore'),
    coal: (n) => n === 'coal_ore' || n === 'deepslate_coal_ore',
    iron: (n) => n === 'iron_ore' || n === 'deepslate_iron_ore',
    sand: (n) => n === 'sand',
    dirt: (n) => n === 'dirt' || n === 'grass_block',
    wool: (n) => n.endsWith('_wool'),
    leaves: (n) => n.endsWith('_leaves'),
  };
  const f = alias[q];
  if (f) return all.filter(f);
  if (bot.registry.blocksByName[q]) return [q];
  return all.filter((n) => n.includes(q));
}

export function findBlocks(bot: Bot, names: string[], maxDistance: number, count: number): Block[] {
  const ids = new Set(names.map((n) => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined));
  if (ids.size === 0) return [];
  return bot
    .findBlocks({ matching: (b) => ids.has(b.type), maxDistance, count })
    .map((p) => bot.blockAt(p))
    .filter((b): b is Block => b !== null);
}

/**
 * pathfinder.goto, retried when it is stopped almost immediately: a collect task cancelled by the previous
 * skill can still stop the pathfinder just after a new goal is set ("Path was stopped...").
 */
async function gotoWithRetry(ctx: SkillContext, goal: () => pathfinderPkg.goals.Goal, timeoutMs: number, label: string): Promise<void> {
  const { bot } = ctx;
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      await withTimeout(bot.pathfinder.goto(goal()), Math.max(1000, deadline - started), label);
      return;
    } catch (e) {
      const stoppedEarly = /stopped/i.test((e as Error).message) && Date.now() - started < 1500;
      if (ctx.signal.aborted || !stoppedEarly || attempt >= 2) throw e;
      await sleep(300);
    }
  }
}

/** A position a bot can stand in: feet and head not solid (and not lava), solid ground below. */
export function isStandable(bot: Bot, p: Vec3): boolean {
  const feet = bot.blockAt(p);
  const head = bot.blockAt(p.offset(0, 1, 0));
  const below = bot.blockAt(p.offset(0, -1, 0));
  const free = (b: Block | null): boolean => !!b && b.boundingBox === 'empty' && b.name !== 'lava';
  return free(feet) && free(head) && isSolid(below);
}

/** Nearest standable position within `radius` blocks of `p` (closest first), or undefined. */
export function nearestStandable(bot: Bot, p: Vec3, radius = 3): Vec3 | undefined {
  const base = p.floored();
  let best: Vec3 | undefined;
  let bestD = Infinity;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const c = base.offset(dx, dy, dz);
        const d = dx * dx + dy * dy * 2 + dz * dz; // prefer same height
        if (d < bestD && isStandable(bot, c)) {
          best = c;
          bestD = d;
        }
      }
    }
  }
  return best;
}

/**
 * Pathfind near a position; aborts with the skill signal; bounded by timeout. For exact targets (range <= 1)
 * the target must be standable; if it is inside blocks we go to the nearest free spot instead.
 */
export async function gotoNear(ctx: SkillContext, x: number, y: number, z: number, range = 1, timeoutMs = 60_000): Promise<void> {
  throwIfAborted(ctx.signal);
  const { bot } = ctx;
  await transitHomeDoor(ctx, { x, y, z });
  if (range <= 1) {
    const target = v3(Math.floor(x), Math.floor(y), Math.floor(z));
    if (bot.blockAt(target) && !isStandable(bot, target)) {
      const alt = nearestStandable(bot, target, 3);
      if (!alt) throw new Error(`target ${fmtPos(target)} is inside blocks and there is no free spot near it`);
      ({ x, y, z } = alt);
    }
  }
  const onAbort = (): void => bot.pathfinder.stop();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await gotoWithRetry(ctx, () => new goals.GoalNear(x, y, z, range), timeoutMs, 'goto');
  } catch (e) {
    bot.pathfinder.stop();
    if (ctx.signal.aborted) throw new AbortError();
    throw e;
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

export async function gotoXZ(ctx: SkillContext, x: number, z: number, timeoutMs = 60_000): Promise<void> {
  const { bot } = ctx;
  await transitHomeDoor(ctx, { x, y: bot.entity.position.y, z });
  const onAbort = (): void => bot.pathfinder.stop();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await gotoWithRetry(ctx, () => new goals.GoalNearXZ(x, z, 2), timeoutMs, 'explore');
  } catch (e) {
    bot.pathfinder.stop();
    if (ctx.signal.aborted) throw new AbortError();
    throw e;
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

export function isAirLike(b: Block | null): boolean {
  if (!b) return false;
  return b.boundingBox === 'empty' && !['water', 'lava'].includes(b.name);
}

export function isSolid(b: Block | null): boolean {
  return !!b && b.boundingBox === 'block';
}

const FACES = [v3(0, -1, 0), v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1), v3(0, 1, 0)];

/** Places `item` at `pos` using any solid neighbour as reference. Returns true on success. */
export async function placeItemAt(ctx: SkillContext, item: Item, pos: Vec3): Promise<boolean> {
  const { bot } = ctx;
  throwIfAborted(ctx.signal);
  const target = bot.blockAt(pos);
  if (!target || !isAirLike(target)) return false;
  // Don't place inside our own body.
  const feet = bot.entity.position.floored();
  if (pos.equals(feet) || pos.equals(feet.offset(0, 1, 0))) return false;
  for (const f of FACES) {
    const ref = bot.blockAt(pos.plus(f));
    if (!isSolid(ref)) continue;
    try {
      if (bot.entity.position.distanceTo(pos) > 4.3) await gotoNear(ctx, pos.x, pos.y, pos.z, 3, 20_000);
      await bot.equip(item, 'hand');
      await bot.placeBlock(ref!, f.scaled(-1));
      await sleep(60);
      return !isAirLike(bot.blockAt(pos));
    } catch (e) {
      ctx.log(`place ${item.name} at ${fmtPos(pos)} against ${ref!.name} failed: ${(e as Error).message}`);
      await sleep(60);
      if (!isAirLike(bot.blockAt(pos))) return true;
    }
  }
  return false;
}

/** An air position adjacent to the bot with a solid block below (for torches, chests...). */
export function freeSpotNearBot(bot: Bot): Vec3 | undefined {
  const base = bot.entity.position.floored();
  const offs = [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1), v3(1, 0, 1), v3(-1, 0, -1), v3(1, 0, -1), v3(-1, 0, 1), v3(2, 0, 0), v3(0, 0, 2)];
  for (const dy of [0, 1, -1]) {
    for (const o of offs) {
      const p = base.plus(o).offset(0, dy, 0);
      if (isAirLike(bot.blockAt(p)) && isSolid(bot.blockAt(p.offset(0, -1, 0)))) return p;
    }
  }
  return undefined;
}

export function fmtPos(p: { x: number; y: number; z: number }): string {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

/** Nearest block of the given names, or undefined. */
export function nearestBlock(bot: Bot, names: string[], maxDistance = 32): Block | undefined {
  return findBlocks(bot, names, maxDistance, 1)[0];
}

/** Blocks that only exist because someone built something. */
export const MAN_MADE_RE =
  /_planks$|_slab$|_stairs$|_door$|_trapdoor$|_fence$|_fence_gate$|glass|torch|lantern|_bed$|crafting_table|chest|barrel|furnace|smoker|_wool$|_carpet$|ladder|_sign$|bricks|_wall$|bookshelf|lectern|campfire|stripped_/;

/** True if a man-made block is within `r` blocks of `p` (cheap cube scan). */
export function nearManMade(bot: Bot, p: Vec3, r = 2): boolean {
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const b = bot.blockAt(p.offset(dx, dy, dz));
        if (b && MAN_MADE_RE.test(b.name)) return true;
      }
    }
  }
  return false;
}

/** A log that belongs to a tree: leaves within a few blocks above/around, and nothing built next to it. */
export function isTreeLog(bot: Bot, b: Block): boolean {
  if (nearManMade(bot, b.position, 2)) return false;
  for (let dy = 0; dy <= 6; dy++) {
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
      const n = bot.blockAt(b.position.offset(dx, dy, dz))?.name ?? '';
      if (n.endsWith('_leaves') || n === 'nether_wart_block' || n === 'warped_wart_block') return true;
    }
  }
  return false;
}

/** True if `p` is inside the box around a home/village spot (shelter footprint ± margin). */
export function inHomeBox(ctx: SkillContext, p: { x: number; y: number; z: number }, margin = 3): boolean {
  return homeContaining(ctx, p, margin) !== undefined;
}

/** The known home (own, village, or any teammate's) whose box contains `p`. */
export function homeContaining(ctx: SkillContext, p: { x: number; y: number; z: number }, margin = 3): { x: number; y: number; z: number } | undefined {
  const homes = [ctx.memory.place('home'), ctx.memory.place('village'), ...(ctx.homes?.all() ?? [])];
  return homes.find((h) => !!h && Math.abs(p.x - h.x) <= margin && Math.abs(p.z - h.z) <= margin && p.y >= h.y - 1 && p.y <= h.y + 3) ?? undefined;
}

/** Blocks that belong to a home or protected area: never mine them. */
export function isHomeBlock(ctx: SkillContext, p: { x: number; y: number; z: number }): boolean {
  return inHomeBox(ctx, p, 5) || !!ctx.protectedAreas?.contains(p);
}

/**
 * Leaving or entering the house through its door, scripted: the pathfinder's own door handling is
 * unreliable and it used to dig through the floor/walls instead. Does nothing unless exactly one of
 * (bot, target) is inside the home box and a door is found near home.
 */
export async function transitHomeDoor(ctx: SkillContext, target: { x: number; y: number; z: number }): Promise<void> {
  const { bot } = ctx;
  const me = bot.entity.position;
  const homeMe = homeContaining(ctx, me, 2);
  const homeTarget = homeContaining(ctx, target, 2);
  // Only when crossing a house wall: exactly one of us/target inside (or inside two different houses).
  const same = (a?: { x: number; y: number; z: number }, b?: { x: number; y: number; z: number }): boolean =>
    (!a && !b) || (!!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z);
  if (same(homeMe, homeTarget)) return;
  const home = homeMe ?? homeTarget!;
  const meIn = same(homeMe, home);
  const doors = findBlocks(bot, Object.keys(bot.registry.blocksByName).filter((n) => n.endsWith('_door') && !n.includes('trap')), 7, 4)
    .filter((b) => Math.abs(b.position.x - home.x) <= 4 && Math.abs(b.position.z - home.z) <= 4)
    .map((b) => (bot.blockAt(b.position.offset(0, -1, 0))?.name.endsWith('_door') ? bot.blockAt(b.position.offset(0, -1, 0))! : b));
  const door = doors[0];
  if (!door) return;
  const d = door.position;
  // Outward direction: from home towards the door, along the dominant axis.
  const dx = d.x - home.x, dz = d.z - home.z;
  const out = Math.abs(dx) >= Math.abs(dz) ? v3(Math.sign(dx) || 1, 0, 0) : v3(0, 0, Math.sign(dz) || 1);
  const inside = d.minus(out);
  const outside = d.plus(out);
  const [from, to] = meIn ? [inside, outside.plus(out)] : [outside, inside];
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(from.x, from.y, from.z)), 15_000, 'door');
    const now = bot.blockAt(d);
    if (now && (now as unknown as { getProperties(): { open?: boolean } }).getProperties().open !== true) await bot.activateBlock(now);
    await sleep(250);
    await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(to.x, to.y, to.z)), 8_000, 'door');
    const after = bot.blockAt(d);
    if (after && (after as unknown as { getProperties(): { open?: boolean } }).getProperties().open === true) await bot.activateBlock(after);
  } catch {
    if (ctx.signal.aborted) throw new AbortError();
    // fall back to normal pathfinding
  }
}
