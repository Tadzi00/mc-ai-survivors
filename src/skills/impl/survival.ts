import type { Entity } from 'prismarine-entity';
import { sleep, throwIfAborted } from '../../util/time.js';
import type { SkillArgsOf } from '../schemas.js';
import type { SkillContext } from '../context.js';
import { fmtPos, gotoNear, nearestBlock } from '../helpers.js';

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

export async function attackSkill(ctx: SkillContext, a: SkillArgsOf<'attack'>): Promise<string> {
  const { bot } = ctx;
  // "cows" -> "cow" (only for real mob names, so player names ending in s stay intact)
  const singular = a.target.toLowerCase().replace(/s$/, '');
  const target = !bot.registry.entitiesByName[a.target.toLowerCase()] && bot.registry.entitiesByName[singular] ? singular : a.target;
  let e = nearestEntity(ctx, target, 48);
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
    if (!e) return `went to where ${target}s were seen (${seen.d.x},${seen.d.y},${seen.d.z}) but they are gone; explore`;
  }
  const sword = bot.inventory.items().find((i) => i.name.endsWith('_sword')) ?? bot.inventory.items().find((i) => i.name.endsWith('_axe'));
  if (sword) await bot.equip(sword, 'hand').catch(() => undefined);
  void bot.pvp.attack(e);
  const deadline = Date.now() + 30_000;
  try {
    while (Date.now() < deadline) {
      await sleep(500, ctx.signal);
      if (!bot.entities[e.id] || !e.isValid) return `defeated/lost ${a.target}`;
      if (bot.health < 6) return `retreated from ${a.target} (low health)`;
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
  await gotoNear(ctx, bed.position.x, bed.position.y, bed.position.z, 2, 60_000);
  throwIfAborted(ctx.signal);
  try {
    await bot.sleep(bed);
  } catch (e) {
    const msg = (e as Error).message;
    if (/not night/.test(msg)) {
      // Daytime: right-clicking still sets spawn → bridge plugin auto-assigns this bed to us.
      await bot.activateBlock(bed).catch(() => undefined);
      ctx.memory.setPlace('bed', bed.position);
      return `it is day; claimed bed at ${fmtPos(bed.position)} (spawn set)`;
    }
    return `could not sleep: ${msg}`;
  }
  ctx.memory.setPlace('bed', bed.position);
  const deadline = Date.now() + 60_000;
  while (bot.isSleeping && Date.now() < deadline) await sleep(1000, ctx.signal);
  return 'slept';
}
