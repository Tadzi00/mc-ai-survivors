import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Item } from 'prismarine-item';
import pathfinderPkg from 'mineflayer-pathfinder';
import vec3 from 'vec3';
import { AbortError, sleep, throwIfAborted, withTimeout } from '../util/time.js';
import type { SkillContext } from './context.js';
import { freeFloor, isKeepClear, scanRoom } from './roomPlan.js';

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
  // A skill cut short (e.g. gather interrupted by an order) can leave the pathfinder/collectblock still
  // walking: placing while moving failed ("could not place the crafting table", then the torch). Stand still.
  if (bot.pathfinder.isMoving() || bot.controlState.forward) {
    bot.pathfinder.stop();
    void (bot as unknown as { collectBlock?: { cancelTask(): Promise<void> } }).collectBlock?.cancelTask().catch(() => undefined);
    bot.clearControlStates();
    await sleep(400);
  }
  // Success = the block there changed. (Checking "not air-like" wrongly failed torches, which are walk-through.)
  const before = target.name;
  const changed = (): boolean => {
    const now = bot.blockAt(pos)?.name;
    return !!now && now !== before && now !== 'air' && now !== 'cave_air';
  };
  for (const f of [...FACES, ...FACES]) { // second round: retry once (a placement right after moving can fail)
    const ref = bot.blockAt(pos.plus(f));
    if (!isSolid(ref)) continue;
    try {
      // Reach is measured like Minecraft does: from the eyes to the block centre. (Feet-to-corner made roof
      // corners look out of reach, so the bot walked "near" them - up the walls onto its own roof.)
      const eyes = bot.entity.position.offset(0, 1.62, 0);
      if (eyes.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.5) {
        ctx.log(`walking to place ${item.name} at ${fmtPos(pos)} (${eyes.distanceTo(pos.offset(0.5, 0.5, 0.5)).toFixed(1)} away)`);
        await gotoNear(ctx, pos.x, pos.y, pos.z, 3, 20_000);
      }
      await bot.equip(item, 'hand');
      await bot.placeBlock(ref!, f.scaled(-1));
      await sleep(60);
      if (changed()) return true;
    } catch (e) {
      ctx.log(`place ${item.name} at ${fmtPos(pos)} against ${ref!.name} failed: ${(e as Error).message}`);
      await sleep(60);
      if (changed()) return true;
    }
  }
  return false;
}

/** An air position adjacent to the bot with a solid block below (for torches, chests...). */
export function freeSpotNearBot(bot: Bot): Vec3 | undefined {
  const base = bot.entity.position.floored();
  // Inside a room: a free floor spot against a wall, never the doorway (a table there blocked the door).
  const room = scanRoom(bot, base);
  if (room) {
    const spot = freeFloor(bot, room).find((c) => c.distanceTo(base) <= 4 && isSolid(bot.blockAt(c.offset(0, -1, 0))));
    if (spot) return spot;
  }
  const offs = [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1), v3(1, 0, 1), v3(-1, 0, -1), v3(1, 0, -1), v3(-1, 0, 1), v3(2, 0, 0), v3(0, 0, 2)];
  for (const dy of [0, 1, -1]) {
    for (const o of offs) {
      const p = base.plus(o).offset(0, dy, 0);
      if (isEmptyCell(bot.blockAt(p)) && isSolid(bot.blockAt(p.offset(0, -1, 0))) && !isKeepClear(bot, p)) return p;
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
  // Stumps and trunks of partly chopped trees: standing on soil or on another log.
  const below = bot.blockAt(b.position.offset(0, -1, 0))?.name ?? '';
  if (/^(dirt|grass_block|podzol|coarse_dirt|rooted_dirt|moss_block|mud|mycelium)$/.test(below) || /_log$/.test(below)) return true;
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
  // Look for the door around the HOUSE, not around the bot: coming from far away the bot used to find no
  // door, walk straight at the wall and try to get in over it.
  const doorIds = new Set(Object.values(bot.registry.blocksByName).filter((b) => b.name.endsWith('_door') && !b.name.includes('trap')).map((b) => b.id));
  const doors = bot
    .findBlocks({ matching: (b) => doorIds.has(b.type), point: v3(home.x, home.y, home.z), maxDistance: 6, count: 8 })
    .map((p) => bot.blockAt(p)!)
    .filter((b) => !!b && Math.abs(b.position.x - home.x) <= 4 && Math.abs(b.position.z - home.z) <= 4)
    .map((b) => (bot.blockAt(b.position.offset(0, -1, 0))?.name.endsWith('_door') ? bot.blockAt(b.position.offset(0, -1, 0))! : b));
  const door = doors[0];
  if (!door) {
    ctx.log(`door transit: no door found near home ${fmtPos(home)}`);
    return;
  }
  ctx.log(`door transit: ${meIn ? 'leaving' : 'entering'} via door at ${fmtPos(door.position)}`);
  const d = door.position;
  // Outward direction: from home towards the door, along the dominant axis.
  const dx = d.x - home.x, dz = d.z - home.z;
  const out = Math.abs(dx) >= Math.abs(dz) ? v3(Math.sign(dx) || 1, 0, 0) : v3(0, 0, Math.sign(dz) || 1);
  const inside = d.minus(out);
  const outside = d.plus(out);
  const [from, to] = meIn ? [inside, outside.plus(out)] : [outside, inside];
  try {
    const far = bot.entity.position.distanceTo(from);
    await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(from.x, from.y, from.z)), Math.min(90_000, 15_000 + far * 600), 'door');
    // Toggle the door only if its panel is in the way (a sideways door is passable closed), walk straight
    // through by hand, then put it back the way it was.
    const axis = out.x !== 0 ? 'x' : 'z';
    const now = bot.blockAt(d);
    const toggled = !!now && doorBlocksAxis(now, axis);
    if (toggled) await bot.activateBlock(now!);
    await sleep(250);
    await walkStraight(bot, to, 4_000);
    const after = bot.blockAt(d);
    if (toggled && after && /_door$/.test(after.name)) await bot.activateBlock(after);
  } catch (e) {
    if (ctx.signal.aborted) throw new AbortError();
    ctx.log(`door transit via ${fmtPos(d)} failed: ${(e as Error).message}`); // fall back to normal pathfinding
  }
}

/** Walks in a straight line (no pathfinding) towards `to` until within 0.6 blocks or `ms` elapsed. */
export async function walkStraight(bot: Bot, to: Vec3, ms: number): Promise<boolean> {
  const target = to.offset(0.5, 0, 0.5);
  const end = Date.now() + ms;
  bot.pathfinder.stop();
  try {
    while (Date.now() < end) {
      const p = bot.entity.position;
      if (Math.hypot(p.x - target.x, p.z - target.z) < 0.6) return true;
      await bot.lookAt(target.offset(0, 1.6, 0), true);
      bot.setControlState('forward', true);
      await sleep(100);
    }
    return false;
  } finally {
    bot.setControlState('forward', false);
  }
}

/** Sky light at head height: 15 = open sky, under ~6 = cave/closed room. */
export function skyLightAt(bot: Bot): number {
  return bot.blockAt(bot.entity.position.offset(0, 1.6, 0))?.skyLight ?? 15;
}

export function isUnderground(bot: Bot): boolean {
  return skyLightAt(bot) < 6 && bot.entity.position.y < 62;
}

/**
 * Get back to open sky: walk to the nearest air block with full sky light within 48 blocks, otherwise dig
 * upward in 8-block steps (the pathfinder may dig stairs; no pillaring). Returns a short result.
 */
export async function goSurface(ctx: SkillContext): Promise<string> {
  const { bot } = ctx;
  if (skyLightAt(bot) >= 13) return 'already under open sky';
  const air = ['air', 'cave_air'].map((n) => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined);
  const open = bot.findBlocks({
    matching: (b) => air.includes(b.type),
    useExtraInfo: (b: Block) => b.skyLight >= 14 && isSolid(bot.blockAt(b.position.offset(0, -1, 0))),
    maxDistance: 48,
    count: 1,
  })[0];
  if (open) {
    try {
      await gotoNear(ctx, open.x, open.y, open.z, 1, 90_000);
    } catch (e) {
      if (ctx.signal.aborted) throw new AbortError();
    }
    if (skyLightAt(bot) >= 13) return `reached open sky at ${fmtPos(bot.entity.position)}`;
  }
  for (let i = 0; i < 8 && skyLightAt(bot) < 13; i++) {
    throwIfAborted(ctx.signal);
    const y = Math.floor(bot.entity.position.y) + 8;
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalY(y)), 45_000, 'surface');
    } catch {
      if (ctx.signal.aborted) throw new AbortError();
      break;
    }
  }
  return skyLightAt(bot) >= 13
    ? `reached open sky at ${fmtPos(bot.entity.position)}`
    : `still underground at ${fmtPos(bot.entity.position)} (sky light ${skyLightAt(bot)}); try go_surface again or mine upward`;
}

/**
 * Emergency night bunker: dig two blocks straight down and seal the hole above the head with a block,
 * so mobs can't reach. Returns the bunker feet position, or undefined (with a reason) if the ground is
 * unsuitable (water/lava/built blocks/air below).
 */
export async function digBunker(ctx: SkillContext): Promise<{ feet?: Vec3; why: string }> {
  const { bot } = ctx;
  // Dig 3 down and seal the cell above the head: at that depth it is surrounded by ground blocks to place
  // against (2 down leaves the opening at surface level with nothing to attach the cover to).
  const top = bot.entity.position.floored();
  const d1 = top.offset(0, -1, 0), d2 = top.offset(0, -2, 0), d3 = top.offset(0, -3, 0), floor = top.offset(0, -4, 0);
  const natural = (b: Block | null): boolean => !!b && b.boundingBox === 'block' && !MAN_MADE_RE.test(b.name) && bot.canDigBlock(b);
  const wet = (p: Vec3): boolean => ['water', 'bubble_column', 'lava'].includes(bot.blockAt(p)?.name ?? '');
  if (wet(top) || wet(top.offset(0, 1, 0))) return { why: 'standing in water: get out of the water first' };
  if (![d1, d2, d3].every((p) => natural(bot.blockAt(p)))) return { why: 'ground here is not diggable (built blocks, water or air below)' };
  if (!isSolid(bot.blockAt(floor))) return { why: 'no solid floor 4 blocks down (cave or water below)' };
  for (const p of [d1, d2, d3]) {
    const n = [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1)].map((o) => bot.blockAt(p.plus(o))?.name ?? '');
    if (n.some((x) => x === 'water' || x === 'lava')) return { why: 'water or lava next to the hole' };
  }
  bot.pathfinder.stop();
  // Stand in the middle of the cell: off-centre, the bot dug the hole next to its feet, never fell in,
  // sealed an empty hole and stayed outside all night thinking it was safe.
  await walkStraight(bot, top, 1500).catch(() => false);
  bot.clearControlStates();
  await sleep(150);
  for (const p of [d1, d2, d3]) {
    if (wet(bot.entity.position.floored()) || wet(bot.entity.position.floored().offset(0, 1, 0))) {
      return { why: 'water flowed in while digging; stopped' };
    }
    await bot.dig(bot.blockAt(p)!, true);
    await sleep(350); // fall a block
  }
  await sleep(500);
  const cover = findItem(bot, /^(dirt|cobblestone|cobbled_deepslate|stone|netherrack|.*_planks|sand|gravel)$/);
  const feetNow = bot.entity.position.floored();
  if (feetNow.x !== d3.x || feetNow.z !== d3.z || feetNow.y > d3.y + 1) {
    return { why: `dug a hole at ${fmtPos(d3)} but did not end up in it (standing at ${fmtPos(feetNow)})` };
  }
  if (!cover) return { feet: d3, why: 'dug in but have no block to seal the top' };
  const ok = await placeItemAt(ctx, cover, d1);
  return { feet: d3, why: ok ? 'dug in and sealed the top' : 'dug in but could not seal the top' };
}

/**
 * Positions of man-made blocks around the bot, refreshed by a periodic scan. Lets the pathfinder's
 * "don't dig next to buildings" rule use set lookups: reading 6 neighbour blocks per candidate made path
 * planning time out ("took too long to decide path") in leafy jungles.
 */
export class ManMadeIndex {
  private cells = new Set<string>();
  private ids: Set<number> | undefined;

  refresh(bot: Bot, radius = 48): void {
    this.ids ??= new Set(Object.values(bot.registry.blocksByName).filter((b) => MAN_MADE_RE.test(b.name)).map((b) => b.id));
    const ids = this.ids;
    const found = bot.findBlocks({ matching: (b) => ids.has(b.type), maxDistance: radius, count: 4000 });
    this.cells = new Set(found.map((p) => `${p.x},${p.y},${p.z}`));
    this.doors = found
      .filter((p) => /_door$/.test(bot.blockAt(p)?.name ?? ''))
      .map((p) => ({ x: p.x, y: p.y, z: p.z }));
  }

  /** Door blocks (iron and wooden) seen at the last refresh. */
  doors: { x: number; y: number; z: number }[] = [];

  /** True if `p` or one of its 6 neighbours is a known man-made block. */
  touches(p: { x: number; y: number; z: number }): boolean {
    if (this.cells.size === 0) return false;
    const { x, y, z } = p;
    return (
      this.cells.has(`${x},${y},${z}`) ||
      this.cells.has(`${x + 1},${y},${z}`) ||
      this.cells.has(`${x - 1},${y},${z}`) ||
      this.cells.has(`${x},${y + 1},${z}`) ||
      this.cells.has(`${x},${y - 1},${z}`) ||
      this.cells.has(`${x},${y},${z + 1}`) ||
      this.cells.has(`${x},${y},${z - 1}`)
    );
  }
}

/**
 * Does this door's panel block walking along `axis`? The panel is a thin slab, thin along the axis it
 * blocks. Open is not the same as passable: a door placed sideways is walkable while closed.
 */
export function doorBlocksAxis(b: Block, axis: 'x' | 'z'): boolean {
  const box = b.shapes?.[0];
  if (!box) return false; // no collision box: walk-through
  const thinX = box[3] - box[0] < 0.5;
  return axis === 'x' ? thinX : !thinX;
}

/**
 * Teach the pathfinder to use wooden doors. Its `canOpenDoors` only covers fence gates, and even that path
 * stalls (it never clears its "placing" flag after using the gate). So a door was a solid block it may not
 * break, routes through doors did not exist and the bot dug a hole beside the door instead.
 * Here wooden doors count as passable when planning, and the bot opens a closed door on its path when it
 * gets there, then closes it again once it is a few blocks past (heat leaks). Iron doors stay solid.
 */
export function enableDoorPathing(bot: Bot, moves: unknown): void {
  const doorIds = new Set(
    Object.values(bot.registry.blocksByName).filter((b) => /_door$/.test(b.name) && b.name !== 'iron_door').map((b) => b.id),
  );
  const isOpen = (b: Block | null | undefined): boolean => {
    const o = (b?.getProperties() as Record<string, unknown> | undefined)?.open;
    return o === true || o === 'true';
  };
  type PBlock = { type?: number; safe?: boolean; physical?: boolean; openable?: boolean };
  const m = moves as { getBlock: (pos: unknown, dx: number, dy: number, dz: number) => PBlock; canOpenDoors: boolean };
  m.canOpenDoors = false; // the built-in gate opening stalls the path; doors are opened below instead
  const getBlock = m.getBlock.bind(moves);
  m.getBlock = (pos, dx, dy, dz) => {
    const b = getBlock(pos, dx, dy, dz);
    if (b?.type !== undefined && doorIds.has(b.type)) {
      b.safe = true; // walk through (opened on arrival)
      b.physical = false; // never stand on a door
      b.openable = false;
    }
    return b;
  };

  let path: { x: number; y: number; z: number }[] = [];
  bot.on('path_update', (r: { path: { x: number; y: number; z: number }[] }) => { path = r.path ?? []; });
  bot.on('goal_reached', () => { path = []; });
  bot.on('path_reset', () => { path = []; });

  const opened = new Map<string, Vec3>(); // lower halves we opened
  let busy = false;
  const timer = setInterval(() => {
    if (!bot.entity || busy) return;
    const me = bot.entity.position;
    // Toggle a door on the path just ahead if its panel blocks the way we walk. A door's panel is a thin
    // slab; "open" is not the same as "passable": a door placed sideways is walkable while CLOSED, and
    // opening it would swing the panel across the doorway.
    if (path.length > 0 && bot.pathfinder.isMoving()) {
      const ahead = path.slice(0, 4);
      for (const [i, n] of ahead.entries()) {
        if (Math.hypot(n.x + 0.5 - me.x, n.y - me.y, n.z + 0.5 - me.z) > 2.6) continue;
        // Walking direction through the door = the path step into it (or out of it if that one is diagonal);
        // not the bot's position, which cuts corners and made the door flap open/shut.
        const prev = i > 0 ? ahead[i - 1]! : { x: Math.floor(me.x), z: Math.floor(me.z) };
        const next = path[i + 1];
        let sx = n.x - prev.x, sz = n.z - prev.z;
        if ((sx !== 0) === (sz !== 0) && next) { sx = next.x - n.x; sz = next.z - n.z; }
        const dxw = Math.abs(sx), dzw = Math.abs(sz);
        for (const dy of [0, 1]) {
          const b = bot.blockAt(new vec3.Vec3(n.x, n.y + dy, n.z));
          if (!b || !doorIds.has(b.type)) continue;
          const lower = (b.getProperties() as Record<string, unknown>).half === 'upper' ? b.position.offset(0, -1, 0) : b.position;
          if (!doorBlocksAxis(b, Math.abs(dxw) >= Math.abs(dzw) ? 'x' : 'z')) break;
          const wasOpen = isOpen(b);
          busy = true;
          bot.activateBlock(b).then(
            () => { if (!wasOpen) opened.set(`${lower.x},${lower.y},${lower.z}`, lower); },
            () => undefined,
          ).finally(() => { setTimeout(() => { busy = false; }, 300); });
          return;
        }
      }
    }
    // close doors we opened once we are past them
    for (const [key, pos] of opened) {
      const d = me.distanceTo(pos.offset(0.5, 0, 0.5));
      if (d > 8) { opened.delete(key); continue; }
      if (d < 2.2 || path.slice(0, 3).some((n) => n.x === pos.x && n.z === pos.z)) continue;
      opened.delete(key);
      const door = bot.blockAt(pos);
      if (door && doorIds.has(door.type) && isOpen(door)) {
        busy = true;
        bot.activateBlock(door).catch(() => undefined).finally(() => { busy = false; });
        return;
      }
    }
  }, 150);
  bot.once('end', () => clearInterval(timer));
}

/**
 * Really empty for placing a block: air, or plants/snow a placed block replaces. NOT a torch, flower, sign...
 * (a torch counted as "free" and the server refused the crafting table there again and again).
 */
export function isEmptyCell(b: Block | null | undefined): boolean {
  return !!b && /^(air|cave_air|void_air|short_grass|grass|tall_grass|fern|large_fern|snow|dead_bush|seagrass)$/.test(b.name);
}

/** Blocks a skill may dig once even inside a home (e.g. taking back its own crafting table). */
export const ALLOWED_DIGS = new Set<string>();
export const digKey = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;
