import type { Item } from 'prismarine-item';
import type { Block } from 'prismarine-block';
import { throwIfAborted } from '../../util/time.js';
import type { SkillArgsOf } from '../schemas.js';
import type { SkillContext } from '../context.js';
import {
  BUILDING_BLOCK_RE, countItem, findItem, fmtPos, freeSpotNearBot, gotoNear, isAirLike, isSolid, MAN_MADE_RE, placeItemAt, v3, type Vec3,
} from '../helpers.js';
import { craftSkill } from './resources.js';

export async function placeBlockSkill(ctx: SkillContext, a: SkillArgsOf<'place_block'>): Promise<string> {
  const { bot } = ctx;
  const item = findItem(bot, a.block.toLowerCase());
  if (!item) return `no ${a.block} in inventory`;
  const pos = a.x !== undefined && a.y !== undefined && a.z !== undefined ? v3(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z)) : freeSpotNearBot(bot);
  if (!pos) return 'no free spot nearby';
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
export async function buildShelterSkill(ctx: SkillContext, a: SkillArgsOf<'build_shelter'>): Promise<string> {
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
  ctx.memory.setPlace('home', origin);
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
  if (bot.entity.position.distanceTo(doorway) > 4) await gotoNear(ctx, inside.x, inside.y, inside.z, 1, 10_000).catch(() => undefined);
  try {
    await bot.equip(door, 'hand');
    await bot.lookAt(doorway.offset(0.5, 0, 0.5), true);
    await bot.placeBlock(floor!, v3(0, 1, 0));
  } catch {
    /* verify below */
  }
  const placed = bot.blockAt(doorway);
  return placed && /_door$/.test(placed.name) ? 'ok' : 'door placement failed';
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
  const base = bot.entity.position.floored();
  const dirs = [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1)];
  for (const d of dirs) {
    const foot = base.plus(d);
    const head = foot.plus(d);
    if (!isAirLike(bot.blockAt(foot)) || !isAirLike(bot.blockAt(head))) continue;
    if (!isSolid(bot.blockAt(foot.offset(0, -1, 0))) || !isSolid(bot.blockAt(head.offset(0, -1, 0)))) continue;
    throwIfAborted(ctx.signal);
    // The bed's head extends away from the player, i.e. in direction d.
    await bot.lookAt(head.offset(0.5, 0, 0.5), true);
    await bot.equip(bedItem, 'hand');
    try {
      await bot.placeBlock(bot.blockAt(foot.offset(0, -1, 0))!, v3(0, 1, 0));
    } catch {
      /* verify below */
    }
    const placed = bot.blockAt(foot);
    if (placed && bot.isABed(placed)) {
      const claimed = ctx.memory.place('bed');
      if (!claimed) {
        // First bed: claim it (bridge auto-assigns on bed use); later beds stay free for newborns.
        await bot.activateBlock(placed).catch(() => undefined);
        ctx.memory.setPlace('bed', foot);
        if (!ctx.memory.place('home')) ctx.memory.setPlace('home', { ...foot, note: 'where my bed is' }); // a bed makes a home
        return `placed and claimed my bed at ${fmtPos(foot)}`;
      }
      ctx.memory.addNote(`Spare bed for a newborn at ${fmtPos(foot)}.`);
      ctx.memory.setPlace('spare_bed', foot);
      return `placed spare bed at ${fmtPos(foot)} (left unclaimed for a newborn)`;
    }
  }
  return 'no room for a bed here (needs 2 free floor blocks in a line next to me)';
}
