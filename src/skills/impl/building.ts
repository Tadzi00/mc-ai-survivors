import type { Item } from 'prismarine-item';
import type { Block } from 'prismarine-block';
import { sleep, throwIfAborted } from '../../util/time.js';
import type { SkillArgsOf } from '../schemas.js';
import type { SkillContext } from '../context.js';
import {
  BUILDING_BLOCK_RE, countItem, findItem, fmtPos, freeSpotNearBot, gotoNear, isAirLike, isSolid, isStandable, MAN_MADE_RE, nearestStandable, placeItemAt, v3, type Vec3,
} from '../helpers.js';
import { isKeepClear, wallsAround } from '../roomPlan.js';
import { plotsNextTo, VILLAGE_RADIUS } from '../../bot/village.js';
import { craftSkill } from './resources.js';

export async function placeBlockSkill(ctx: SkillContext, a: SkillArgsOf<'place_block'>): Promise<string> {
  const { bot } = ctx;
  const item = findItem(bot, a.block.toLowerCase());
  if (!item) return `no ${a.block} in inventory`;
  const pos = a.x !== undefined && a.y !== undefined && a.z !== undefined ? v3(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z)) : freeSpotNearBot(bot);
  if (!pos) return 'no free spot nearby';
  if (!/_door$|torch|lantern/.test(item.name) && isKeepClear(bot, pos)) {
    return `not placing ${item.name} at ${fmtPos(pos)}: that is the doorway (keep it clear); use a free spot from the room plan`;
  }
  const ok = await placeItemAt(ctx, item, pos);
  return ok ? `placed ${item.name} at ${fmtPos(pos)}` : `could not place ${item.name} at ${fmtPos(pos)}`;
}

export async function placeTorchSkill(ctx: SkillContext): Promise<string> {
  const { bot } = ctx;
  if (countItem(bot, 'torch') === 0) {
    const r = await craftSkill(ctx, { item: 'torch', count: 4 });
    if (!r.startsWith('crafted')) return `no torch: ${r} (torch = coal/charcoal + stick)`;
  }
  const spot = freeSpotNearBot(bot);
  const torch = findItem(bot, 'torch');
  if (!spot || !torch) return 'no spot for a torch';
  return (await placeItemAt(ctx, torch, spot)) ? `placed torch at ${fmtPos(spot)}` : 'failed to place torch';
}

/**
 * A block that already stands where a wall/roof/floor block should go only counts if it is a real
 * building block. Leaves, panes, fences, snow, ice etc. leak heat (and leaves decay), so they are
 * dug out and replaced.
 */
const WEAK_BLOCK_RE = /leaves|_pane$|fence|snow|ice$|sapling|bamboo|cactus|scaffolding|mushroom|vine|azalea|_carpet$|torch|_door$|_trapdoor$/;
function isGoodShellBlock(b: Block | null): boolean {
  return isSolid(b) && !WEAK_BLOCK_RE.test(b!.name);
}

/** Picks the most plentiful building block stack, refreshed as stacks run out. */
function pickBuildingItem(ctx: SkillContext): Item | undefined {
  const items = ctx.bot.inventory.items().filter((i) => BUILDING_BLOCK_RE.test(i.name));
  items.sort((a, b) => b.count - a.count);
  return items[0];
}

/**
 * Deterministic shelter template centred on the bot: square footprint `size` (outer), walls 3 high,
 * flat roof, a door in the south wall, a torch inside. Existing solid blocks are reused.
 */
/** Builds a shelter here, or, if this spot is unsuitable (built stuff / solid hill), at up to 4 spots ~7 blocks away. */
export async function buildShelterSkill(ctx: SkillContext, a: SkillArgsOf<'build_shelter'>): Promise<string> {
  const village = ctx.village;
  const { bot } = ctx;
  // One village: once it exists, every new building goes there, next to the others (with a path between).
  if (village?.center) {
    const c = village.center;
    if (Math.hypot(bot.entity.position.x - c.x, bot.entity.position.z - c.z) > VILLAGE_RADIUS) {
      await gotoNear(ctx, c.x, c.y, c.z, 3, 120_000).catch(() => undefined);
      if (Math.hypot(bot.entity.position.x - c.x, bot.entity.position.z - c.z) > VILLAGE_RADIUS) {
        return `build in the village at ${fmtPos(c)}, not out here: goto {"place":"village"} first (could not get there now)`;
      }
    }
    const plots = plotsNextTo(village.data.buildings, a.size, c);
    const tried: string[] = [];
    for (const plot of plots.slice(0, 6)) {
      throwIfAborted(ctx.signal);
      const target = nearestStandable(bot, v3(plot.x, plot.y, plot.z), 2);
      if (!target) continue;
      try {
        await gotoNear(ctx, target.x, target.y, target.z, 0, 30_000);
      } catch {
        continue;
      }
      if (bot.entity.position.floored().distanceTo(target) > 1.5) continue;
      const r = await buildShelterHere(ctx, a);
      if (!/^(too enclosed|something built is in the way)/.test(r)) return `${r} (village plot next to the other buildings)`;
      tried.push(r.split(';')[0]!);
    }
    if (village.data.buildings.length > 0) {
      return `no free plot next to the village buildings (${tried.length} tried${tried[0] ? `: ${tried[0]}` : ''}); clear flat ground beside them or extend_shelter`;
    }
  }
  const first = await buildShelterHere(ctx, a);
  if (!/^(too enclosed|something built is in the way)/.test(first)) return first;
  const start = bot.entity.position.floored();
  const step = a.size + 2;
  for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
    throwIfAborted(ctx.signal);
    const target = nearestStandable(bot, start.offset(dx, 0, dz), 3);
    if (!target) continue;
    try {
      await gotoNear(ctx, target.x, target.y, target.z, 0, 20_000);
    } catch {
      continue;
    }
    const r = await buildShelterHere(ctx, a);
    if (!/^(too enclosed|something built is in the way)/.test(r)) return `${r} (moved ${dx},${dz} from the first spot: ${first.split(';')[0]})`;
  }
  return `${first}; tried 4 spots around too - explore to open flat ground and retry`;
}

async function buildShelterHere(ctx: SkillContext, a: SkillArgsOf<'build_shelter'>): Promise<string> {
  const { bot } = ctx;
  const s = a.size;
  const origin = bot.entity.position.floored();
  const half = Math.floor(s / 2);
  const x0 = origin.x - half, z0 = origin.z - half, x1 = x0 + s - 1, z1 = z0 + s - 1, y0 = origin.y;

  // The inside must be (or be made) empty: a "shelter" in a hillside used to be solid stone with a door
  // into rock. Dig out a few natural blocks; refuse if the spot is mostly solid.
  const interior: Vec3[] = [];
  for (let x = x0 + 1; x <= x1 - 1; x++) for (let z = z0 + 1; z <= z1 - 1; z++) for (let dy = 0; dy < 3; dy++) interior.push(v3(x, y0 + dy, z));
  const solidInside = interior.filter((p) => bot.blockAt(p)?.boundingBox === 'block');
  if (solidInside.length > 20) {
    return `too enclosed here (${solidInside.length} solid blocks inside the outline, maybe inside a hill/cave); move to open flat ground (explore) and retry`;
  }
  if (solidInside.some((p) => MAN_MADE_RE.test(bot.blockAt(p)!.name) || ctx.protectedAreas?.contains(p))) {
    return 'something built is in the way here; move a few blocks and retry';
  }

  // Door on the wall side that opens to free space (feet+head free, ground below just outside).
  const sides = [
    { x: x0 + half, z: z1, out: v3(0, 0, 1) },
    { x: x0 + half, z: z0, out: v3(0, 0, -1) },
    { x: x1, z: z0 + half, out: v3(1, 0, 0) },
    { x: x0, z: z0 + half, out: v3(-1, 0, 0) },
  ];
  const openness = (d: (typeof sides)[number]): number => {
    const o = v3(d.x, y0, d.z).plus(d.out);
    return (isAirLike(bot.blockAt(o)) ? 1 : 0) + (isAirLike(bot.blockAt(o.offset(0, 1, 0))) ? 1 : 0) + (isSolid(bot.blockAt(o.offset(0, -1, 0))) ? 1 : 0);
  };
  const doorSide = [...sides].sort((p, q) => openness(q) - openness(p))[0]!;
  const doorX = doorSide.x, doorZ = doorSide.z;

  const wall: Vec3[] = [];
  const roof: Vec3[] = [];
  for (let dy = 0; dy < 3; dy++) {
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const edge = x === x0 || x === x1 || z === z0 || z === z1;
        if (!edge) continue;
        if (x === doorX && z === doorZ && dy < 2) continue;
        wall.push(v3(x, y0 + dy, z));
      }
    }
  }
  // Roof from the outside ring inwards so every block has a placed neighbour.
  for (let ring = 0; ring <= half; ring++) {
    for (let x = x0 + ring; x <= x1 - ring; x++) {
      for (let z = z0 + ring; z <= z1 - ring; z++) {
        const onRing = x === x0 + ring || x === x1 - ring || z === z0 + ring || z === z1 - ring;
        if (onRing) roof.push(v3(x, y0 + 3, z));
      }
    }
  }
  // Floor holes under walls/interior would leak: fill air below the footprint.
  const floor: Vec3[] = [];
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) floor.push(v3(x, y0 - 1, z));

  const needed = [...floor, ...wall, ...roof].filter((p) => !isGoodShellBlock(bot.blockAt(p))).length;
  const have = bot.inventory.items().filter((i) => BUILDING_BLOCK_RE.test(i.name)).reduce((n, i) => n + i.count, 0);
  if (have < needed) {
    return `not enough blocks: need ${needed}, have ${have} (planks/cobblestone/dirt/logs). Gather more first.`;
  }
  // Craft the door FIRST so building doesn't use up the planks it needs (door = 6 planks).
  let doorWhy = '';
  if (countItem(bot, /_door$/) === 0) {
    const r = await craftSkill(ctx, { item: doorNameFor(ctx), count: 1 });
    if (!r.startsWith('crafted')) doorWhy = r;
  }
  const hasDoor = countItem(bot, /_door$/) > 0;

  // Stand in the centre so everything is within reach.
  await gotoNear(ctx, origin.x, origin.y, origin.z, 0, 15_000).catch(() => undefined);

  // Hollow out the inside, and clear the way out in front of the door (2 blocks out, feet + head).
  for (const p of solidInside) {
    const b = bot.blockAt(p);
    if (b && b.boundingBox === 'block' && bot.canDigBlock(b)) await bot.dig(b, true).catch(() => undefined);
  }
  for (let k = 1; k <= 2; k++) {
    const o = v3(doorX, y0, doorZ).plus(doorSide.out.scaled(k));
    for (const p of [o, o.offset(0, 1, 0)]) {
      const b = bot.blockAt(p);
      if (b && b.boundingBox === 'block' && !MAN_MADE_RE.test(b.name) && !ctx.protectedAreas?.contains(p) && bot.canDigBlock(b)) {
        await bot.dig(b, true).catch(() => undefined);
      }
    }
  }

  let placed = 0, failed = 0, replaced = 0;
  for (const p of [...floor, ...wall, ...roof]) {
    throwIfAborted(ctx.signal);
    const existing = bot.blockAt(p);
    if (isGoodShellBlock(existing)) continue;
    if (existing && existing.boundingBox === 'block' && bot.canDigBlock(existing)) {
      // leaves & co: remove, then place a proper block
      await bot.dig(existing, true).catch(() => undefined);
      replaced++;
    }
    const item = pickBuildingItem(ctx);
    if (!item) break;
    if (await placeItemAt(ctx, item, p)) placed++;
    else failed++;
  }
  let doorOk = false;
  if (hasDoor) {
    const r = await placeDoor(ctx, v3(doorX, y0, doorZ), origin);
    doorOk = r === 'ok';
    if (!doorOk) doorWhy = r;
  }
  if (!doorOk) {
    // No door: seal the doorway so the room still counts as sealed. Remembered so the bot can fix it.
    for (const p of [v3(doorX, y0, doorZ), v3(doorX, y0 + 1, doorZ)]) {
      const item = pickBuildingItem(ctx);
      if (item) await placeItemAt(ctx, item, p);
    }
    ctx.memory.setPlace('doorway', v3(doorX, y0, doorZ));
  }
  // Torch on the floor inside, away from the centre.
  let torchMsg = 'no torch';
  if (countItem(bot, 'torch') > 0 || (await craftSkill(ctx, { item: 'torch', count: 2 })).startsWith('crafted')) {
    const torch = findItem(bot, 'torch');
    const tp = v3(x0 + 1, y0, z0 + 1);
    if (torch && isAirLike(bot.blockAt(tp)) && (await placeItemAt(ctx, torch, tp))) torchMsg = 'torch placed';
  }
  if (torchMsg === 'torch placed' && ctx.seasons.enabled) {
    await gotoNear(ctx, origin.x, origin.y, origin.z, 0, 8_000).catch(() => undefined);
    torchMsg = await heatRoomSkill(ctx, 4);
  }
  // Home: the first shelter becomes home; later ones are extra rooms of the village (the home stays put,
  // bots kept "forgetting" their home by building a new one somewhere and moving there).
  const oldHome = ctx.memory.place('home');
  const keepOld = !!oldHome && (!ctx.village || ctx.village.contains(oldHome));
  if (!keepOld) ctx.memory.setPlace('home', origin);
  ctx.village?.addBuilding({ x0, z0, x1, z1, y0, door: doorOk ? { x: doorX, y: y0, z: doorZ } : undefined, owner: ctx.name });
  if (!ctx.memory.place('village') && ctx.village?.center) ctx.memory.setPlace('village', ctx.village.center);
  (ctx.memory.data.shelters ??= []).push({ x0, z0, x1, z1, y0 });
  ctx.memory.save();
  ctx.memory.addNote(
    `Built shelter (size ${s}) at ${fmtPos(origin)}${doorOk ? ` with door at ${doorX},${y0},${doorZ}` : `; doorway at ${doorX},${y0},${doorZ} is walled up (no door: ${doorWhy.slice(0, 60)})`}.`,
  );
  return `shelter at ${fmtPos(origin)}: placed ${placed} blocks (${replaced} leaves/weak blocks replaced), ${failed} failed, ${doorOk ? 'door ok' : `NO DOOR (${doorWhy.slice(0, 80)}) - doorway walled up; craft a door (6 planks) and run add_door`}, ${torchMsg}. Next: place_bed inside.`;
}

/**
 * Places a door in a doorway: clears the two doorway cells, stands inside facing out, and places the door
 * on TOP of the floor block (doors can only be placed on a block's top face). Returns 'ok' or a reason.
 */
async function placeDoor(ctx: SkillContext, doorway: Vec3, inside: Vec3): Promise<string> {
  const { bot } = ctx;
  const door = findItem(bot, /_door$/);
  if (!door) return 'no door item';
  for (const p of [doorway, doorway.offset(0, 1, 0)]) {
    const b = bot.blockAt(p);
    if (b && b.boundingBox === 'block') {
      if (/_door$/.test(b.name)) return 'ok';
      if (!bot.canDigBlock(b)) return `cannot clear ${b.name} in the doorway`;
      await bot.dig(b, true).catch(() => undefined);
    }
  }
  const floor = bot.blockAt(doorway.offset(0, -1, 0));
  if (!isSolid(floor)) return 'no solid floor under the doorway';
  // The door takes the direction the bot faces when placing (mineflayer turns to the floor block itself).
  // Stand on the cell just inside the doorway, in line with it, so the door faces straight out of the wall.
  const along = doorAxis(doorway, inside);
  const sign = along === 'x' ? Math.sign(inside.x - doorway.x) || 1 : Math.sign(inside.z - doorway.z) || 1;
  const stand = along === 'x' ? doorway.offset(sign, 0, 0) : doorway.offset(0, 0, sign);
  for (let attempt = 0; attempt < 2; attempt++) {
    await gotoXZExact(ctx, stand);
    try {
      await bot.equip(door, 'hand');
      await bot.lookAt(doorway.offset(0.5, 0.5, 0.5), true);
      await bot.placeBlock(floor!, v3(0, 1, 0));
    } catch (e) {
      ctx.log(
        `door placement at ${fmtPos(doorway)}: ${(e as Error).message} | held=${bot.heldItem?.name} doors=${countItem(bot, /_door$/)} ` +
          `me=${fmtPos(bot.entity.position)} floor=${floor?.name} cell=${bot.blockAt(doorway)?.name}/${bot.blockAt(doorway.offset(0, 1, 0))?.name}`,
      );
    }
    await sleep(150);
    const placed = bot.blockAt(doorway);
    if (!placed || !/_door$/.test(placed.name)) return 'door placement failed';
    const facing = String((placed.getProperties() as Record<string, unknown>).facing);
    const facingAxis = facing === 'east' || facing === 'west' ? 'x' : 'z';
    if (facingAxis === along) return 'ok';
    // Sideways door (panel along the passage): pick it up and place it again.
    ctx.log(`door at ${fmtPos(doorway)} faces ${facing}, passage runs along ${along}: replacing it`);
    await bot.dig(placed, true).catch(() => undefined);
    await pickUpNear(ctx, doorway);
  }
  return bot.blockAt(doorway) && /_door$/.test(bot.blockAt(doorway)!.name) ? 'ok' : 'door placement failed';
}

/** Axis a doorway passage runs along: the wall normal, i.e. the axis with the bigger offset to the inside. */
function doorAxis(doorway: Vec3, inside: Vec3): 'x' | 'z' {
  return Math.abs(inside.x - doorway.x) > Math.abs(inside.z - doorway.z) ? 'x' : 'z';
}

/** Walk onto the centre of block `p` (best effort, short). */
async function gotoXZExact(ctx: SkillContext, p: Vec3): Promise<void> {
  const { bot } = ctx;
  if (bot.entity.position.floored().equals(p)) return;
  await gotoNear(ctx, p.x, p.y, p.z, 0, 10_000).catch(() => undefined);
}

/** Collect dropped items lying within 3 blocks of `p`. */
async function pickUpNear(ctx: SkillContext, p: Vec3): Promise<void> {
  const { bot } = ctx;
  await sleep(300);
  for (const e of Object.values(bot.entities)) {
    if (e.name !== 'item' || e.position.distanceTo(p) > 3) continue;
    await gotoNear(ctx, e.position.x, e.position.y, e.position.z, 0, 4000).catch(() => undefined);
  }
}

/** add_door skill: put a door into a walled-up or empty doorway of your shelter. */
export async function addDoorSkill(ctx: SkillContext): Promise<string> {
  const { bot } = ctx;
  const home = ctx.memory.place('home');
  if (!home) return 'no home known (build_shelter first)';
  // Shelters built before doorways were remembered: the template puts the door in the middle of the
  // south wall, 2 blocks from the centre (size 5; size 4-7 use floor(size/2)).
  let doorway = ctx.memory.place('doorway');
  if (!doorway) {
    for (const dz of [2, 3, 1]) {
      const b = bot.blockAt(v3(home.x, home.y, home.z + dz));
      if (b && /_door$/.test(b.name)) return 'your shelter already has a door';
      if (b && b.boundingBox === 'block' && bot.blockAt(v3(home.x, home.y, home.z + dz + 1))?.boundingBox !== 'block') {
        doorway = { x: home.x, y: home.y, z: home.z + dz };
        break;
      }
    }
    if (!doorway) return 'could not find the doorway of your shelter';
  }
  if (countItem(bot, /_door$/) === 0) {
    const r = await craftSkill(ctx, { item: doorNameFor(ctx), count: 1 });
    if (!r.startsWith('crafted')) return `need a door first: ${r}`;
  }
  const r = await placeDoor(ctx, v3(doorway.x, doorway.y, doorway.z), v3(home.x, home.y, home.z));
  if (r !== 'ok') return `could not add door: ${r}`;
  delete ctx.memory.data.places.doorway;
  ctx.memory.addNote(`Added a door to my shelter at ${fmtPos(doorway)}.`);
  return `door added at ${fmtPos(doorway)}`;
}

function doorNameFor(ctx: SkillContext): string {
  const planks = findItem(ctx.bot, /_planks$/);
  return planks ? planks.name.replace(/_planks$/, '_door') : 'oak_door';
}

export async function placeBedSkill(ctx: SkillContext): Promise<string> {
  const { bot } = ctx;
  const bedItem = findItem(bot, /_bed$/);
  if (!bedItem) return 'no bed item (craft "white_bed": 3 white_wool + 3 planks)';
  // A bed needs two free floor cells in a line (foot, head). Its head points the way the player faces, so
  // stand on the cell behind the foot and place it facing forward. Works in a 3x3 room (corners/edges).
  const base = bot.entity.position.floored();
  const dirs = [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1)];
  const free = (p: Vec3): boolean => isAirLike(bot.blockAt(p)) && isAirLike(bot.blockAt(p.offset(0, 1, 0))) && isSolid(bot.blockAt(p.offset(0, -1, 0)));
  const options: Array<{ foot: Vec3; head: Vec3; stand: Vec3; d: Vec3; cost: number }> = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (const dy of [0, -1, 1]) {
        const foot = base.offset(dx, dy, dz);
        for (const d of dirs) {
          const head = foot.plus(d);
          const stand = foot.minus(d);
          if (!free(foot) || !free(head) || !isStandable(bot, stand)) continue;
          if (isKeepClear(bot, foot) || isKeepClear(bot, head)) continue; // never in the doorway
          // against walls is better than across the middle of the room
          const walls = wallsAround(bot, foot) + wallsAround(bot, head);
          options.push({ foot, head, stand, d, cost: stand.distanceTo(base) + (dy !== 0 ? 3 : 0) - walls * 0.7 });
        }
      }
    }
  }
  options.sort((p, q) => p.cost - q.cost);
  for (const o of options.slice(0, 4)) {
    throwIfAborted(ctx.signal);
    if (!o.stand.equals(base)) {
      try {
        await gotoNear(ctx, o.stand.x, o.stand.y, o.stand.z, 0, 15_000);
      } catch {
        continue;
      }
    }
    await bot.equip(bedItem, 'hand');
    await bot.lookAt(o.head.offset(0.5, 0.2, 0.5), true);
    try {
      await bot.placeBlock(bot.blockAt(o.foot.offset(0, -1, 0))!, v3(0, 1, 0));
    } catch (e) {
      ctx.log(`bed at ${fmtPos(o.foot)}: ${(e as Error).message}`);
    }
    await sleep(200);
    const placed = bot.blockAt(o.foot);
    if (placed && bot.isABed(placed)) {
      const claimed = ctx.memory.place('bed');
      if (!claimed) {
        // First bed: claim it (bridge auto-assigns on bed use); later beds stay free for newborns.
        await bot.activateBlock(placed).catch(() => undefined);
        ctx.memory.setPlace('bed', o.foot);
        if (!ctx.memory.place('home')) ctx.memory.setPlace('home', { ...o.foot, note: 'where my bed is' }); // a bed makes a home
        return `placed and claimed my bed at ${fmtPos(o.foot)}`;
      }
      ctx.memory.addNote(`Spare bed for a newborn at ${fmtPos(o.foot)}.`);
      ctx.memory.setPlace('spare_bed', o.foot);
      return `placed spare bed at ${fmtPos(o.foot)} (left unclaimed for a newborn)`;
    }
  }
  return options.length ? 'could not place the bed (tried the free spots nearby)' : 'no room for a bed here (needs 2 free floor blocks in a line, plus a spot to stand behind them)';
}

/**
 * plant_sapling: plant up to `count` saplings from the inventory on grass/dirt within 5 blocks that has 2
 * free blocks above and no other sapling/log within 2 blocks (room to grow).
 */
export async function plantSaplingSkill(ctx: SkillContext, a: SkillArgsOf<'plant_sapling'>): Promise<string> {
  const { bot } = ctx;
  let planted = 0;
  for (let i = 0; i < a.count; i++) {
    const sapling = findItem(bot, /_sapling$|^mangrove_propagule$/);
    if (!sapling) break;
    const base = bot.entity.position.floored();
    let spot: Vec3 | undefined;
    for (let r = 1; r <= 5 && !spot; r++) {
      for (let dx = -r; dx <= r && !spot; dx++) {
        for (let dz = -r; dz <= r && !spot; dz++) {
          for (const dy of [0, -1, 1]) {
            const p = base.offset(dx, dy, dz);
            const ground = bot.blockAt(p.offset(0, -1, 0))?.name ?? '';
            if (!/^(grass_block|dirt|podzol|coarse_dirt|rooted_dirt|moss_block|mud)$/.test(ground)) continue;
            if (!isAirLike(bot.blockAt(p)) || !isAirLike(bot.blockAt(p.offset(0, 1, 0)))) continue;
            if (p.equals(base) || p.equals(base.offset(0, 1, 0))) continue;
            let crowded = false;
            for (let ox = -2; ox <= 2 && !crowded; ox++) for (let oz = -2; oz <= 2 && !crowded; oz++) {
              const n = bot.blockAt(p.offset(ox, 0, oz))?.name ?? '';
              if (n.endsWith('_sapling') || n.endsWith('_log')) crowded = true;
            }
            if (!crowded) {
              spot = p;
              break;
            }
          }
        }
      }
    }
    if (!spot) break;
    if (await placeItemAt(ctx, sapling, spot)) planted++;
    else break;
  }
  if (planted === 0) return findItem(bot, /_sapling$/) ? 'no free grass/dirt spot with room to grow nearby' : 'no saplings in inventory (leaves drop them)';
  ctx.memory.discover('planted saplings', bot.entity.position);
  return `planted ${planted} sapling(s); they grow into trees in a few days`;
}

/**
 * extend_shelter: add a room against one side of the bot's shelter. The rooms share that wall and get a
 * 2-high opening in it, so they form one big sealed space with the original door.
 */
export async function extendShelterSkill(ctx: SkillContext, a: SkillArgsOf<'extend_shelter'>): Promise<string> {
  const { bot } = ctx;
  const me = bot.entity.position;
  const list = ctx.memory.data.shelters ?? [];
  const base = [...list].sort(
    (p, q) => Math.hypot((p.x0 + p.x1) / 2 - me.x, (p.z0 + p.z1) / 2 - me.z) - Math.hypot((q.x0 + q.x1) / 2 - me.x, (q.z0 + q.z1) / 2 - me.z),
  )[0];
  if (!base) return 'no shelter of yours to extend (build_shelter first)';
  const L = a.length;
  const y0 = base.y0;
  // New outline: shares the wall on the chosen side.
  let box: { x0: number; z0: number; x1: number; z1: number };
  let shared: Vec3[]; // opening cells in the shared wall (feet + head)
  const midX = Math.floor((base.x0 + base.x1) / 2), midZ = Math.floor((base.z0 + base.z1) / 2);
  switch (a.direction) {
    case 'east':
      box = { x0: base.x1, x1: base.x1 + L - 1, z0: base.z0, z1: base.z1 };
      shared = [v3(base.x1, y0, midZ), v3(base.x1, y0 + 1, midZ)];
      break;
    case 'west':
      box = { x0: base.x0 - L + 1, x1: base.x0, z0: base.z0, z1: base.z1 };
      shared = [v3(base.x0, y0, midZ), v3(base.x0, y0 + 1, midZ)];
      break;
    case 'south':
      box = { x0: base.x0, x1: base.x1, z0: base.z1, z1: base.z1 + L - 1 };
      shared = [v3(midX, y0, base.z1), v3(midX, y0 + 1, base.z1)];
      break;
    default:
      box = { x0: base.x0, x1: base.x1, z0: base.z0 - L + 1, z1: base.z0 };
      shared = [v3(midX, y0, base.z0), v3(midX, y0 + 1, base.z0)];
  }
  const inBase = (x: number, z: number): boolean => x >= base.x0 && x <= base.x1 && z >= base.z0 && z <= base.z1;
  const wall: Vec3[] = [];
  const roof: Vec3[] = [];
  const floor: Vec3[] = [];
  const interior: Vec3[] = [];
  for (let x = box.x0; x <= box.x1; x++) {
    for (let z = box.z0; z <= box.z1; z++) {
      const edge = x === box.x0 || x === box.x1 || z === box.z0 || z === box.z1;
      if (!inBase(x, z)) {
        floor.push(v3(x, y0 - 1, z));
        roof.push(v3(x, y0 + 3, z));
        for (let dy = 0; dy < 3; dy++) (edge ? wall : interior).push(v3(x, y0 + dy, z));
      }
    }
  }
  const solidInside = interior.filter((p) => bot.blockAt(p)?.boundingBox === 'block');
  if (solidInside.length > 20) return `too much solid ground on the ${a.direction} side; try another direction`;
  if ([...solidInside, ...wall].some((p) => ctx.protectedAreas?.contains(p) || (bot.blockAt(p) && MAN_MADE_RE.test(bot.blockAt(p)!.name) && !inBase(p.x, p.z)))) {
    return `something built is in the way on the ${a.direction} side; try another direction`;
  }
  // Roof order: cells next to the existing roof first, so every block has a neighbour to attach to.
  const sharedX = a.direction === 'east' ? base.x1 : a.direction === 'west' ? base.x0 : undefined;
  const sharedZ = a.direction === 'south' ? base.z1 : a.direction === 'north' ? base.z0 : undefined;
  roof.sort((p, q) => (sharedX !== undefined ? Math.abs(p.x - sharedX) - Math.abs(q.x - sharedX) : Math.abs(p.z - sharedZ!) - Math.abs(q.z - sharedZ!)));
  const cells = [...floor, ...wall, ...roof];
  const needed = cells.filter((p) => !isGoodShellBlock(bot.blockAt(p))).length;
  const have = bot.inventory.items().filter((i) => BUILDING_BLOCK_RE.test(i.name)).reduce((n, i) => n + i.count, 0);
  if (have < needed) return `not enough blocks: need ${needed}, have ${have} (planks/cobblestone/dirt/logs). Gather more first.`;

  const centre = v3(Math.floor((box.x0 + box.x1) / 2), y0, Math.floor((box.z0 + box.z1) / 2));
  // Open the shared wall FIRST (from inside the old room) so the bot can walk through it into the new room
  // instead of going out through the door or trying to dig.
  let opened = 0;
  const doorThere = shared.some((p) => /_door$/.test(bot.blockAt(p)?.name ?? ''));
  if (!doorThere) {
    const inside = v3(midX, y0, midZ);
    if (bot.entity.position.distanceTo(shared[0]!) > 4) await gotoNear(ctx, inside.x, inside.y, inside.z, 1, 15_000).catch(() => undefined);
    for (const p of shared) {
      const b = bot.blockAt(p);
      if (b && b.boundingBox === 'block' && bot.canDigBlock(b)) {
        await bot.dig(b, true).catch(() => undefined);
        opened++;
      }
    }
  }
  await gotoNear(ctx, centre.x, centre.y, centre.z, 1, 20_000).catch(() => undefined);
  for (const p of solidInside) {
    const b = bot.blockAt(p);
    if (b && b.boundingBox === 'block' && bot.canDigBlock(b)) await bot.dig(b, true).catch(() => undefined);
  }
  let placed = 0, failed = 0;
  for (const p of cells) {
    throwIfAborted(ctx.signal);
    const existing = bot.blockAt(p);
    if (isGoodShellBlock(existing)) continue;
    if (existing && existing.boundingBox === 'block' && bot.canDigBlock(existing)) await bot.dig(existing, true).catch(() => undefined);
    const item = pickBuildingItem(ctx);
    if (!item) break;
    if (await placeItemAt(ctx, item, p)) placed++;
    else failed++;
  }
  let torchMsg = 'no torch';
  if (countItem(bot, 'torch') > 0 || (await craftSkill(ctx, { item: 'torch', count: 2 })).startsWith('crafted')) {
    const torch = findItem(bot, 'torch');
    const tp = interior.find((p) => isAirLike(bot.blockAt(p)) && p.y === y0 && isSolid(bot.blockAt(p.offset(0, -1, 0))));
    if (torch && tp && (await placeItemAt(ctx, torch, tp))) torchMsg = 'torch placed';
  }
  (ctx.memory.data.shelters ??= []).push({ ...box, y0 });
  ctx.memory.save();
  ctx.memory.addNote(`Extended my shelter ${a.direction} by ${L} (${box.x0},${box.z0} to ${box.x1},${box.z1}).`);
  return `added a room on the ${a.direction} side: placed ${placed} blocks, ${failed} failed, ${opened ? 'opening made in the shared wall' : doorThere ? 'rooms connected through the old door' : 'shared wall already open'}, ${torchMsg}`;
}

/**
 * heat_room: place torches inside the room the bot stands in, one at a time, re-checking the real room
 * temperature (RealisticSeasons) after each, until it is comfortable, too hot, or 6 torches were added.
 * How many depends on the weather: in summer 1 torch keeps a 5x5 room warm, on a cold night it took ~4.
 */
export async function heatRoomSkill(ctx: SkillContext, max = 6): Promise<string> {
  const { bot } = ctx;
  // Judge by the temperature the room is HEADING to (thermal inertia makes the current one lag minutes).
  const read = async (): Promise<{ tempC: number; comfortable: boolean; inside: boolean; sealed: boolean } | undefined> => {
    if (!ctx.seasons.enabled) return undefined;
    const p = bot.entity.position.floored();
    const r = await ctx.seasons.room(p.x, p.y, p.z).catch(() => undefined);
    if (!r) return undefined;
    const t = r.equilibriumC ?? r.tempC;
    return { tempC: t, comfortable: r.equilibriumC !== undefined ? t >= 12 && t <= 28 : r.comfortable, inside: r.inside, sealed: r.sealed };
  };
  let r = await read();
  if (r && !r.inside) return `you are not inside a room (${r.tempC.toFixed(1)}C): go inside your shelter first`;
  if (r && r.comfortable) return `room is already warm enough (heading to ${r.tempC.toFixed(1)}C)`;
  let added = 0;
  const base = bot.entity.position.floored();
  // Floor spots INSIDE this room: flood fill from the bot through open cells at its height (walls and doors
  // stop it). A plain radius also found cells behind the walls, and torches went outside.
  const spots: Vec3[] = [];
  const seen = new Set<string>([`${base.x},${base.z}`]);
  const queue: Vec3[] = [base];
  while (queue.length && seen.size < 200) {
    const c = queue.shift()!;
    for (const d of [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1)]) {
      const n = c.plus(d);
      const key = `${n.x},${n.z}`;
      if (seen.has(key) || Math.abs(n.x - base.x) > 8 || Math.abs(n.z - base.z) > 8) continue;
      seen.add(key);
      const b = bot.blockAt(n);
      if (!isAirLike(b) || /_door$/.test(b?.name ?? '')) continue;
      queue.push(n);
      if (isSolid(bot.blockAt(n.offset(0, -1, 0)))) spots.push(n);
    }
  }
  spots.sort((p, q) => q.distanceTo(base) - p.distanceTo(base)); // far (edges/corners) first
  for (const p of spots) {
    if (added >= max) break;
    if (r && (r.comfortable || r.tempC > 28)) break;
    if (countItem(bot, 'torch') === 0) {
      const c = await craftSkill(ctx, { item: 'torch', count: 4 });
      if (!c.startsWith('crafted')) return `added ${added} torch(es)${r ? `, room ${r.tempC.toFixed(1)}C` : ''}; need more torches: ${c}`;
    }
    const torch = findItem(bot, 'torch');
    if (!torch || p.distanceTo(bot.entity.position) > 4.5) continue;
    if (!(await placeItemAt(ctx, torch, p))) continue;
    added++;
    await sleep(600); // let the plugin rescan the room
    r = await read();
  }
  if (!r) return `placed ${added} torch(es) (no temperature readings on this server)`;
  return `placed ${added} torch(es); room warming to ${r.tempC.toFixed(1)}C, ${r.comfortable ? 'comfortable' : r.tempC > 28 ? 'too hot' : 'still cold - add more heat'}${r.sealed ? '' : ' (room is NOT sealed: fix holes)'}`;
}
