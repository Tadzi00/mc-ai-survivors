import type { Item } from 'prismarine-item';
import { throwIfAborted } from '../../util/time.js';
import type { SkillArgsOf } from '../schemas.js';
import type { SkillContext } from '../context.js';
import {
  BUILDING_BLOCK_RE, countItem, findItem, fmtPos, freeSpotNearBot, gotoNear, isAirLike, isSolid, placeItemAt, v3, type Vec3,
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
  const doorX = x0 + half, doorZ = z1;

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

  const needed = [...floor, ...wall, ...roof].filter((p) => !isSolid(bot.blockAt(p))).length;
  const have = bot.inventory.items().filter((i) => BUILDING_BLOCK_RE.test(i.name)).reduce((n, i) => n + i.count, 0);
  if (have < needed) {
    return `not enough blocks: need ${needed}, have ${have} (planks/cobblestone/dirt/logs). Gather more first.`;
  }
  const hasDoor = countItem(bot, /_door$/) > 0 || (await craftSkill(ctx, { item: doorNameFor(ctx), count: 1 })).startsWith('crafted');

  // Stand in the centre so everything is within reach.
  await gotoNear(ctx, origin.x, origin.y, origin.z, 0, 15_000).catch(() => undefined);

  let placed = 0, failed = 0;
  for (const p of [...floor, ...wall, ...roof]) {
    throwIfAborted(ctx.signal);
    if (isSolid(bot.blockAt(p))) continue;
    const item = pickBuildingItem(ctx);
    if (!item) break;
    if (await placeItemAt(ctx, item, p)) placed++;
    else failed++;
  }
  let doorOk = false;
  if (hasDoor) {
    const door = findItem(bot, /_door$/);
    if (door) doorOk = await placeItemAt(ctx, door, v3(doorX, y0, doorZ));
  }
  if (!doorOk) {
    // No door: seal the doorway instead so the room is still valid (exit by digging).
    for (const p of [v3(doorX, y0, doorZ), v3(doorX, y0 + 1, doorZ)]) {
      const item = pickBuildingItem(ctx);
      if (item) await placeItemAt(ctx, item, p);
    }
  }
  // Torch on the floor inside, away from the centre.
  let torchMsg = 'no torch';
  if (countItem(bot, 'torch') > 0 || (await craftSkill(ctx, { item: 'torch', count: 2 })).startsWith('crafted')) {
    const torch = findItem(bot, 'torch');
    const tp = v3(x0 + 1, y0, z0 + 1);
    if (torch && isAirLike(bot.blockAt(tp)) && (await placeItemAt(ctx, torch, tp))) torchMsg = 'torch placed';
  }
  ctx.memory.setPlace('home', origin);
  ctx.memory.addNote(`Built shelter (size ${s}) at ${fmtPos(origin)}${doorOk ? ' with door on south side' : ' (sealed, no door)'}.`);
  return `shelter at ${fmtPos(origin)}: placed ${placed} blocks, ${failed} failed, ${doorOk ? 'door ok' : 'no door (sealed)'}, ${torchMsg}. Next: place_bed inside.`;
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
        return `placed and claimed my bed at ${fmtPos(foot)}`;
      }
      ctx.memory.addNote(`Spare bed for a newborn at ${fmtPos(foot)}.`);
      return `placed spare bed at ${fmtPos(foot)} (left unclaimed for a newborn)`;
    }
  }
  return 'no room for a bed here (needs 2 free floor blocks in a line next to me)';
}
