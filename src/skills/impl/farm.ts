import { sleep, throwIfAborted } from '../../util/time.js';
import type { SkillArgsOf } from '../schemas.js';
import type { SkillContext } from '../context.js';
import { findBlocks, findItem, gotoNear, isAirLike, v3 } from '../helpers.js';

const CROPS = {
  wheat: { block: 'wheat', seed: 'wheat_seeds', maxAge: 7 },
  carrot: { block: 'carrots', seed: 'carrot', maxAge: 7 },
  potato: { block: 'potatoes', seed: 'potato', maxAge: 7 },
  beetroot: { block: 'beetroots', seed: 'beetroot_seeds', maxAge: 3 },
} as const;

export async function farmSkill(ctx: SkillContext, a: SkillArgsOf<'farm'>): Promise<string> {
  const { bot } = ctx;
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
