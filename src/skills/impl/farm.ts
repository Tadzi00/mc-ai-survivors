import { sleep, throwIfAborted } from '../../util/time.js';
import type { SkillArgsOf } from '../schemas.js';
import type { SkillContext } from '../context.js';
import { countItem, findBlocks, findItem, fmtPos, gotoNear, isAirLike, isEmptyCell, placeItemAt, v3, type Vec3 } from '../helpers.js';
import { bestFieldSite } from '../fieldPlan.js';
import { craftSkill } from './resources.js';

/** Ground a hoe turns into farmland, and shore ground we replace with dirt first. */
const TILLABLE = ['grass_block', 'dirt', 'dirt_path', 'coarse_dirt', 'rooted_dirt'];
const SWAPPABLE = ['sand', 'gravel', 'podzol', 'red_sand', 'mycelium', 'clay'];

const CROPS = {
  wheat: { block: 'wheat', seed: 'wheat_seeds', maxAge: 7 },
  carrot: { block: 'carrots', seed: 'carrot', maxAge: 7 },
  potato: { block: 'potatoes', seed: 'potato', maxAge: 7 },
  beetroot: { block: 'beetroots', seed: 'beetroot_seeds', maxAge: 3 },
} as const;

/** Break grass until we have `n` wheat seeds (about 1 in 8 grass drops one). */
export async function collectSeeds(ctx: SkillContext, n: number): Promise<number> {
  const { bot } = ctx;
  const have = (): number => countItem(bot, 'wheat_seeds');
  const start = have();
  for (let round = 0; round < 60 && have() < n; round++) {
    throwIfAborted(ctx.signal);
    const g = findBlocks(bot, ['short_grass', 'grass', 'tall_grass', 'fern', 'large_fern'], 32, 1)[0];
    if (!g) break;
    await gotoNear(ctx, g.position.x, g.position.y, g.position.z, 2, 15_000).catch(() => undefined);
    await bot.dig(g, true).catch(() => undefined);
    await sleep(250);
    const drop = Object.values(bot.entities).find((e) => e.name === 'item' && e.position.distanceTo(g.position) < 2.5);
    if (drop) await gotoNear(ctx, drop.position.x, drop.position.y, drop.position.z, 0, 3000).catch(() => undefined);
  }
  return have() - start;
}

/** Make (if needed) the village field next to water: hoe, seeds, till, plant. */
async function setupField(ctx: SkillContext): Promise<string> {
  const { bot } = ctx;
  const known = ctx.village?.data.field ?? ctx.memory.place('field');
  if (known) return `the village already has a field at ${fmtPos(known)} - use farm {"action":"tend"} there`;
  const center = ctx.village?.center ?? ctx.memory.place('home') ?? bot.entity.position.floored();
  if (bot.entity.position.distanceTo(v3(center.x, center.y, center.z)) > 24) await gotoNear(ctx, center.x, center.y, center.z, 3, 90_000).catch(() => undefined);
  const look = (): ReturnType<typeof bestFieldSite> => {
    const waterId = bot.registry.blocksByName.water!.id;
    const waters = bot
      .findBlocks({ matching: waterId, maxDistance: 56, count: 600 })
      .filter((p) => isAirLike(bot.blockAt(p.offset(0, 1, 0))));
    // Tillable ground, plus shore blocks we can swap for a dirt block (sand, gravel, podzol...).
    const soilIds = new Set([...TILLABLE, ...SWAPPABLE].map((n) => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined));
    const soil = bot
      .findBlocks({ matching: (b) => soilIds.has(b.type), maxDistance: 60, count: 4000 })
      .filter((p) => isEmptyCell(bot.blockAt(p.offset(0, 1, 0))));
    return bestFieldSite(waters, soil, center);
  };
  let site = look();
  if (!site) {
    // Go to the nearest water we remember and look again there.
    const me = bot.entity.position;
    const w = (ctx.memory.data.discoveries ?? [])
      .filter((d) => d.what === 'water' && Math.hypot(d.x - me.x, d.z - me.z) <= 150)
      .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
    if (w) {
      await gotoNear(ctx, w.x, w.y, w.z, 4, 90_000).catch(() => undefined);
      site = look();
    }
  }
  if (!site) return 'no water with flat land next to it nearby (or remembered): a field needs water within 4 blocks at the same height (or carry water in a bucket: 3 iron)';
  // hoe and seeds
  if (!findItem(bot, /_hoe$/)) {
    const r = await craftSkill(ctx, { item: 'wooden_hoe', count: 1 });
    if (!findItem(bot, /_hoe$/)) return `need a hoe for the field: ${r}`;
  }
  const want = Math.min(site.tiles.length, 24);
  if (countItem(bot, 'wheat_seeds') < Math.min(want, 8)) await collectSeeds(ctx, Math.min(want, 12));
  const seeds = countItem(bot, 'wheat_seeds');
  if (seeds === 0) return 'no wheat seeds (break tall grass to find some) - nothing to plant yet';
  // till only as many as we can plant (bare farmland turns back into dirt)
  // prefer real soil; swap shore blocks only while we carry dirt
  const isSoil = (t: { x: number; y: number; z: number }): boolean => TILLABLE.includes(bot.blockAt(v3(t.x, t.y, t.z))?.name ?? '');
  const ordered = [...site.tiles.filter(isSoil), ...site.tiles.filter((t) => !isSoil(t)).slice(0, countItem(bot, 'dirt'))];
  const tiles = ordered.slice(0, Math.min(want, seeds));
  const tilled = await tillAndPlant(ctx, tiles);
  const w = site.water;
  ctx.village?.setField({ x: w.x, y: w.y, z: w.z }, tilled);
  ctx.memory.setPlace('field', { x: w.x, y: w.y, z: w.z, note: `wheat field (${tilled} planted)` });
  return tilled
    ? `made the village wheat field by the water at ${fmtPos(w)}: ${tilled} seeds planted. Wheat ripens in ~30-60 min; then farm {"action":"tend"} harvests, replants and bakes bread`
    : 'could not till or plant the field';
}

async function tillAndPlant(ctx: SkillContext, tiles: Vec3[] | Array<{ x: number; y: number; z: number }>): Promise<number> {
  const { bot } = ctx;
  let planted = 0;
  for (const t of tiles) {
    throwIfAborted(ctx.signal);
    const p = v3(t.x, t.y, t.z);
    const hoe = findItem(bot, /_hoe$/);
    const seed = findItem(bot, 'wheat_seeds');
    if (!seed) break;
    await gotoNear(ctx, p.x, p.y, p.z, 2, 15_000).catch(() => undefined);
    let b = bot.blockAt(p);
    // Sand/gravel/podzol on the shore: put a dirt block there first.
    if (b && SWAPPABLE.includes(b.name)) {
      const dirt = findItem(bot, 'dirt');
      if (!dirt) continue;
      await bot.dig(b, true).catch(() => undefined);
      await placeItemAt(ctx, dirt, p);
      b = bot.blockAt(p);
    }
    if (b && TILLABLE.includes(b.name) && hoe) {
      const above = bot.blockAt(p.offset(0, 1, 0));
      if (above && above.name !== 'air' && isEmptyCell(above)) await bot.dig(above, true).catch(() => undefined); // grass on top
      await bot.equip(hoe, 'hand');
      await bot.activateBlock(b).catch(() => undefined);
      await sleep(200);
      b = bot.blockAt(p);
    }
    if (b?.name !== 'farmland' || bot.blockAt(p.offset(0, 1, 0))?.name !== 'air') continue; // (wheat is walk-through too)
    await bot.equip(seed, 'hand');
    await bot.placeBlock(b, v3(0, 1, 0)).catch(() => undefined);
    await sleep(120);
    if (bot.blockAt(p.offset(0, 1, 0))?.name === 'wheat') planted++;
  }
  return planted;
}

/** Look after the field: harvest ripe wheat, pick it up, replant, bake bread. */
async function tendField(ctx: SkillContext): Promise<string> {
  const { bot } = ctx;
  const f = ctx.village?.data.field ?? ctx.memory.place('field');
  if (!f) return 'no field yet: farm {"action":"setup"} makes one by the water';
  await gotoNear(ctx, f.x, f.y, f.z, 3, 90_000).catch(() => undefined);
  const near = (p: Vec3): boolean => Math.abs(p.x - f.x) <= 5 && Math.abs(p.z - f.z) <= 5 && Math.abs(p.y - f.y) <= 2;
  const ripe = findBlocks(bot, ['wheat'], 12, 80).filter((b) => near(b.position) && Number(b.getProperties().age ?? 0) >= 7);
  let harvested = 0;
  for (const b of ripe) {
    throwIfAborted(ctx.signal);
    await gotoNear(ctx, b.position.x, b.position.y, b.position.z, 1, 15_000).catch(() => undefined);
    await bot.dig(b, true).catch(() => undefined);
    harvested++;
    await sleep(200);
    for (const e of Object.values(bot.entities)) {
      if (e.name === 'item' && e.position.distanceTo(b.position) < 2.5) await gotoNear(ctx, e.position.x, e.position.y, e.position.z, 0, 2500).catch(() => undefined);
    }
  }
  // replant every empty farmland of the field
  const empty = findBlocks(bot, ['farmland'], 12, 80).filter((b) => near(b.position) && bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air');
  const replanted = await tillAndPlant(ctx, empty.map((b) => b.position));
  let bread = '';
  if (countItem(bot, 'wheat') >= 3) {
    const r = await craftSkill(ctx, { item: 'bread', count: Math.floor(countItem(bot, 'wheat') / 3) });
    bread = r.startsWith('crafted') ? `; ${r.replace(/^crafted/, 'baked')}` : '';
  }
  const growing = findBlocks(bot, ['wheat'], 12, 80).filter((b) => near(b.position)).length;
  ctx.village?.tendedField();
  return `field at ${fmtPos(f)}: harvested ${harvested}, replanted ${replanted}, ${growing} growing${bread}`;
}

export async function farmSkill(ctx: SkillContext, a: SkillArgsOf<'farm'>): Promise<string> {
  const { bot } = ctx;
  if (a.action === 'setup') return setupField(ctx);
  if (a.action === 'tend') return tendField(ctx);
  const crop = CROPS[a.crop];
  if (a.action === 'till') {
    const hoe = findItem(bot, /_hoe$/);
    if (!hoe) return 'need a hoe (craft wooden_hoe)';
    const soil = findBlocks(bot, ['dirt', 'grass_block'], 12, 32).filter((b) => isAirLike(bot.blockAt(b.position.offset(0, 1, 0))));
    let n = 0;
    for (const b of soil.slice(0, 8)) {
      throwIfAborted(ctx.signal);
      await gotoNear(ctx, b.position.x, b.position.y, b.position.z, 2, 20_000).catch(() => undefined);
      await bot.equip(hoe, 'hand');
      await bot.activateBlock(b).catch(() => undefined);
      await sleep(150);
      if (bot.blockAt(b.position)?.name === 'farmland') n++;
    }
    return `tilled ${n} blocks (crops need water within 4 blocks; in winter only indoors with heat)`;
  }
  if (a.action === 'plant') {
    let n = 0;
    const farmland = findBlocks(bot, ['farmland'], 16, 64).filter((b) => isAirLike(bot.blockAt(b.position.offset(0, 1, 0))));
    for (const b of farmland) {
      throwIfAborted(ctx.signal);
      const seed = findItem(bot, crop.seed);
      if (!seed) break;
      await gotoNear(ctx, b.position.x, b.position.y, b.position.z, 2, 20_000).catch(() => undefined);
      await bot.equip(seed, 'hand');
      await bot.placeBlock(b, v3(0, 1, 0)).catch(() => undefined);
      n++;
    }
    return n ? `planted ${n} ${crop.seed}` : `no free farmland or no ${crop.seed}`;
  }
  const ripe = findBlocks(bot, [crop.block], 16, 64).filter((b) => Number(b.getProperties().age ?? 0) >= crop.maxAge);
  let n = 0;
  for (const b of ripe) {
    throwIfAborted(ctx.signal);
    await gotoNear(ctx, b.position.x, b.position.y, b.position.z, 1, 20_000).catch(() => undefined);
    await bot.dig(b).catch(() => undefined);
    n++;
  }
  if (n) {
    // Walk over drops briefly.
    await sleep(800, ctx.signal);
  }
  return n ? `harvested ${n} ${crop.block} (replant with farm plant)` : `no ripe ${crop.block} nearby`;
}
