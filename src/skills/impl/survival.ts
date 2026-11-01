import { exploreSkill } from './movement.js';
import { craftSkill } from './resources.js';
import type { Entity } from 'prismarine-entity';
import { sleep, throwIfAborted } from '../../util/time.js';
import type { SkillArgsOf } from '../schemas.js';
import type { SkillContext } from '../context.js';
import { fmtPos, goSurface, gotoNear, HOSTILE_MOBS, isStandable, isUnderground, nearestBlock, v3 } from '../helpers.js';

export function nearestEntity(ctx: SkillContext, target: string, maxDist = 24): Entity | undefined {
  const { bot } = ctx;
  const t = target.toLowerCase();
  let best: Entity | undefined;
  let bestD = Infinity;
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position) continue;
    const match = e.type === 'player' ? e.username?.toLowerCase() === t : e.name?.toLowerCase() === t;
    if (!match) continue;
    const d = e.position.distanceTo(bot.entity.position);
    if (d < bestD && d <= maxDist) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

const FOOD_ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];

/**
 * Pick ripe sweet berries (right-click, the bush stays and regrows) from up to 6 bushes within 48 blocks.
 * Returns how many berries were gained.
 */
export async function pickBerries(ctx: SkillContext): Promise<number> {
  const { bot } = ctx;
  const id = bot.registry.blocksByName.sweet_berry_bush?.id;
  if (id === undefined) return 0;
  const count = (): number => bot.inventory.items().filter((i) => i.name === 'sweet_berries').reduce((n, i) => n + i.count, 0);
  const before = count();
  const ripe = bot
    .findBlocks({ matching: (b) => b.type === id && Number((b.getProperties() as { age?: number }).age ?? 0) >= 2, maxDistance: 48, count: 12 })
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
  for (const p of ripe.slice(0, 6)) {
    throwIfAborted(ctx.signal);
    await gotoNear(ctx, p.x, p.y, p.z, 2, 20_000).catch(() => undefined);
    const b = bot.blockAt(p);
    if (b && b.type === id) await bot.activateBlock(b).catch(() => undefined);
    await sleep(400);
    const drop = Object.values(bot.entities).find((e) => e.name === 'item' && e.position.distanceTo(p) < 3);
    if (drop) await gotoNear(ctx, drop.position.x, drop.position.y, drop.position.z, 0, 4000).catch(() => undefined);
  }
  return count() - before;
}

/** Any food animal remembered within 160 blocks? */
function rememberedPrey(ctx: SkillContext): boolean {
  const me = ctx.bot.entity.position;
  return (ctx.memory.data.discoveries ?? []).some((d) => FOOD_ANIMALS.some((f) => d.what === `${f}s`) && Math.hypot(d.x - me.x, d.z - me.z) <= 160);
}

export async function attackSkill(ctx: SkillContext, a: SkillArgsOf<'attack'>): Promise<string> {
  const { bot } = ctx;
  // "cows" -> "cow" (only for real mob names, so player names ending in s stay intact)
  const singular = a.target.toLowerCase().replace(/s$/, '');
  const target = !bot.registry.entitiesByName[a.target.toLowerCase()] && bot.registry.entitiesByName[singular] ? singular : a.target;
  let e = nearestEntity(ctx, target, 48);
  if (!e && isUnderground(bot) && bot.registry.entitiesByName[target.toLowerCase()]?.category === 'Passive mobs') {
    await goSurface(ctx); // animals live on the surface
    e = nearestEntity(ctx, target, 48);
  }
  // Hungry bots asked for "cow" again and again where there were none: any food animal will do, and if none
  // is around, go and look for one (like gather explores).
  const isFoodAnimal = FOOD_ANIMALS.includes(target.toLowerCase());
  let substitute = '';
  if (!e && isFoodAnimal) {
    for (const alt of FOOD_ANIMALS) {
      e = nearestEntity(ctx, alt, 48);
      if (e) {
        substitute = alt;
        break;
      }
    }
  }
  if (!e && isFoodAnimal && !rememberedPrey(ctx)) {
    const dirs = ['north', 'east', 'south', 'west'];
    const start = Math.floor(Math.random() * 4);
    for (let k = 0; k < 2 && !e; k++) {
      await exploreSkill(ctx, { direction: dirs[(start + k) % 4] as 'north', distance: 56 }).catch(() => '');
      for (const alt of [target.toLowerCase(), ...FOOD_ANIMALS]) {
        e = nearestEntity(ctx, alt, 48);
        if (e) {
          substitute = alt === target.toLowerCase() ? '' : alt;
          break;
        }
      }
    }
    if (!e) {
      // No animals left here (they hardly respawn): ripe sweet berries keep you alive.
      const berries = await pickBerries(ctx);
      if (berries > 0) return `no animals around, picked ${berries} sweet berries instead (eat them; the bushes regrow)`;
      return `no animals to eat within 48 blocks even after exploring ~110 blocks and no ripe berry bushes; try another area or farm (seeds from grass)`;
    }
  }
  if (substitute) ctx.log(`no ${target} around, hunting a ${substitute} instead`);
  if (!e) {
    // Go where this animal was seen before (auto-memory), then look again.
    const me = bot.entity.position;
    const seen = (ctx.memory.data.discoveries ?? [])
      .filter((d) => d.what === `${target.toLowerCase()}s`)
      .map((d) => ({ d, dist: Math.hypot(d.x - me.x, d.z - me.z) }))
      .filter((x) => x.dist <= 160)
      .sort((p, q) => p.dist - q.dist)[0];
    if (!seen) return `no ${target} within 48 blocks and none remembered; explore to find some`;
    await gotoNear(ctx, seen.d.x, seen.d.y, seen.d.z, 4, 60_000).catch(() => undefined);
    e = nearestEntity(ctx, target, 32);
    if (!e) {
      // stale memory: forget this herd so the next try looks elsewhere
      ctx.memory.data.discoveries = (ctx.memory.data.discoveries ?? []).filter((d) => d !== seen.d);
      ctx.memory.save();
      return `went to where ${target}s were seen (${seen.d.x},${seen.d.y},${seen.d.z}) but they are gone (forgot that spot); explore`;
    }
  }
  const sword = bot.inventory.items().find((i) => i.name.endsWith('_sword')) ?? bot.inventory.items().find((i) => i.name.endsWith('_axe'));
  if (sword) await bot.equip(sword, 'hand').catch(() => undefined);
  void bot.pvp.attack(e);
  const deadline = Date.now() + 30_000;
  try {
    while (Date.now() < deadline) {
      await sleep(500, ctx.signal);
      if (!bot.entities[e.id] || !e.isValid) {
        const got = await pickUpDrops(ctx, e.position.clone());
        return `defeated/lost ${a.target}${got ? `, picked up ${got} drop(s)` : ''}`;
      }
      // Only back off from things that hit back; a starving bot must still be able to kill a cow.
      if (bot.health < 6 && HOSTILE_MOBS.has(e.name ?? '')) return `retreated from ${a.target} (low health)`;
    }
  } finally {
    await bot.pvp.stop().catch(() => bot.pvp.forceStop());
  }
  return `fought ${a.target} for 30s, it is still alive`;
}

export async function eatSkill(ctx: SkillContext): Promise<string> {
  const { bot } = ctx;
  const foods = bot.registry.foodsByName;
  const avoid = /rotten_flesh|spider_eye|poisonous_potato|pufferfish|suspicious_stew/;
  const items = bot.inventory.items().filter((i) => foods[i.name] && !avoid.test(i.name));
  if (items.length === 0) {
    const bad = bot.inventory.items().find((i) => foods[i.name]);
    if (!bad || bot.food > 6) return 'no food in inventory';
    items.push(bad);
  }
  if (bot.food >= 20) return 'not hungry';
  items.sort((x, y) => (foods[y.name]?.foodPoints ?? 0) - (foods[x.name]?.foodPoints ?? 0));
  const food = items[0]!;
  await bot.equip(food, 'hand');
  await bot.consume();
  return `ate ${food.name}, food now ${bot.food}`;
}

export async function sleepSkill(ctx: SkillContext): Promise<string> {
  const { bot } = ctx;
  const known = ctx.memory.place('bed');
  let bed = known ? bot.blockAt(bot.entity.position.clone().set(known.x, known.y, known.z)) : null;
  if (!bed || !bot.isABed(bed)) {
    const beds = Object.keys(bot.registry.blocksByName).filter((n) => n.endsWith('_bed'));
    bed = nearestBlock(bot, beds, 32) ?? null;
  }
  if (!bed) return 'no bed known or nearby (craft one: 3 wool + 3 planks, then place_bed)';
  // Walk to a free spot NEXT to the bed (either half), not at the bed itself: aiming at the bed block made
  // the pathfinder push into it.
  const b0 = bed.position;
  const halves = [b0, ...[v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1)].map((o) => b0.plus(o)).filter((p) => bot.isABed(bot.blockAt(p)!))];
  const spots = halves
    .flatMap((h) => [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1)].map((o) => h.plus(o)))
    .filter((p) => !halves.some((h) => h.equals(p)) && isStandable(bot, p))
    .sort((p, q) => p.distanceTo(bot.entity.position) - q.distanceTo(bot.entity.position));
  if (bot.entity.position.distanceTo(b0.offset(0.5, 0.5, 0.5)) > 2.5) {
    if (spots.length === 0) return `the bed at ${fmtPos(b0)} is blocked in (no free spot next to it)`;
    let reached = false;
    for (const sp of spots.slice(0, 3)) {
      try {
        await gotoNear(ctx, sp.x, sp.y, sp.z, 0, 30_000);
        reached = true;
        break;
      } catch {
        throwIfAborted(ctx.signal);
      }
    }
    if (!reached) return `could not reach the bed at ${fmtPos(b0)}`;
  }
  throwIfAborted(ctx.signal);
  try {
    await bot.sleep(bed);
  } catch (e) {
    const msg = (e as Error).message;
    if (/not night/.test(msg)) {
      // Daytime: right-clicking still sets spawn → bridge plugin auto-assigns this bed to us.
      await bot.activateBlock(bed).catch(() => undefined);
      ctx.memory.setPlace('bed', bed.position);
      if (!ctx.memory.place('home')) ctx.memory.setPlace('home', { ...bed.position, note: 'where my bed is' }); // a bed makes a home
      return `it is day; claimed bed at ${fmtPos(bed.position)} (spawn set)`;
    }
    return `could not sleep: ${msg}`;
  }
  ctx.memory.setPlace('bed', bed.position);
  if (!ctx.memory.place('home')) ctx.memory.setPlace('home', { ...bed.position, note: 'where my bed is' }); // a bed makes a home
  const deadline = Date.now() + 60_000;
  while (bot.isSleeping && Date.now() < deadline) await sleep(1000, ctx.signal);
  return 'slept';
}

/** Walk over item drops near `where` (meat, wool, leather...) so they are actually collected. */
async function pickUpDrops(ctx: SkillContext, where: { x: number; y: number; z: number }): Promise<number> {
  const { bot } = ctx;
  await sleep(500); // drops spawn a moment after death
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const drop = Object.values(bot.entities)
      .filter((x) => x.name === 'item' && x.position.distanceTo(bot.entity.position.clone().set(where.x, where.y, where.z)) < 8)
      .sort((p, q) => p.position.distanceTo(bot.entity.position) - q.position.distanceTo(bot.entity.position))[0];
    if (!drop) break;
    await gotoNear(ctx, drop.position.x, drop.position.y, drop.position.z, 0, 6_000).catch(() => undefined);
    await sleep(300);
    n++;
  }
  return n;
}

/** Sheep flags (metadata index 17): low 4 bits colour, 0x10 = sheared. */
function isSheared(e: Entity): boolean {
  const flags = Number((e.metadata as unknown as unknown[] | undefined)?.[17] ?? 0);
  return (flags & 0x10) !== 0;
}

/**
 * shear: wool without killing the sheep (it grows back after eating grass). Makes shears from 2 iron if
 * needed, shears up to `count` woolly sheep within 32 blocks and picks the wool up.
 */
export async function shearSkill(ctx: SkillContext, a: SkillArgsOf<'shear'>): Promise<string> {
  const { bot } = ctx;
  const woolCount = (): number => bot.inventory.items().filter((i) => i.name.endsWith('_wool')).reduce((n, i) => n + i.count, 0);
  if (!bot.inventory.items().some((i) => i.name === 'shears')) {
    const r = await craftSkill(ctx, { item: 'shears', count: 1 });
    if (!bot.inventory.items().some((i) => i.name === 'shears')) return `need shears (2 iron ingots): ${r}`;
  }
  const before = woolCount();
  const tried = new Set<number>();
  let sheared = 0;
  for (let k = 0; k < a.count; k++) {
    throwIfAborted(ctx.signal);
    const me = bot.entity.position;
    const sheep = Object.values(bot.entities)
      .filter((e) => e.name === 'sheep' && !tried.has(e.id) && !isSheared(e) && e.position.distanceTo(me) <= 32)
      .sort((p, q) => p.position.distanceTo(me) - q.position.distanceTo(me))[0];
    if (!sheep) break;
    tried.add(sheep.id);
    await gotoNear(ctx, sheep.position.x, sheep.position.y, sheep.position.z, 1.5, 20_000).catch(() => undefined);
    if (sheep.position.distanceTo(bot.entity.position) > 4) continue;
    const shears = bot.inventory.items().find((i) => i.name === 'shears');
    if (!shears) break;
    await bot.equip(shears, 'hand');
    await bot.lookAt(sheep.position.offset(0, 0.8, 0), true);
    const w0 = woolCount();
    await bot.activateEntity(sheep).catch(() => undefined);
    await sleep(500);
    // the wool pops out around the sheep: walk over it
    for (const e of Object.values(bot.entities)) {
      if (e.name === 'item' && e.position.distanceTo(sheep.position) < 4) await gotoNear(ctx, e.position.x, e.position.y, e.position.z, 0, 2500).catch(() => undefined);
    }
    if (woolCount() > w0 || isSheared(sheep)) sheared++;
  }
  const got = woolCount() - before;
  if (!sheared && !got) return 'no woolly sheep within 32 blocks (sheared sheep regrow wool by eating grass)';
  return `sheared ${sheared} sheep, +${got} wool (they live on and regrow it)`;
}
