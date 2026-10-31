import type { Block } from 'prismarine-block';
import type { SkillArgsOf } from '../schemas.js';
import type { SkillContext } from '../context.js';
import { fmtPos, gotoNear, nearestBlock } from '../helpers.js';
import { sleep } from '../../util/time.js';
import { nearestEntity } from './survival.js';

function parseItemSpec(spec: string): { name: string; count?: number } {
  const [name, c] = spec.split(':');
  const count = c ? Number.parseInt(c, 10) : undefined;
  return { name: name!.trim().toLowerCase(), count: Number.isFinite(count) ? count : undefined };
}

/** Remember what a chest holds (shown as a place note in the observation; shareable knowledge). */
function rememberChest(ctx: SkillContext, block: Block, items: Array<{ name: string; count: number }>): void {
  const sum = new Map<string, number>();
  for (const i of items) sum.set(i.name, (sum.get(i.name) ?? 0) + i.count);
  const note = sum.size ? [...sum].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `${c} ${n}`).join(', ') : 'empty';
  ctx.memory.setPlace('chest', { ...block.position, note: `contains ${note}` });
}

const invCount = (ctx: SkillContext, name: string): number =>
  ctx.bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
/** Count inside the open chest. While a container is open the player-inventory view lags, the chest side doesn't. */
const chestCount = (chest: { containerItems(): Array<{ name: string; count: number }> }, name: string): number =>
  chest.containerItems().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);

async function openNearestChest(ctx: SkillContext): Promise<{ block: Block } | string> {
  const { bot } = ctx;
  const block = nearestBlock(bot, ['chest', 'barrel', 'trapped_chest'], 24);
  if (!block) return 'no chest within 24 blocks (craft one: 8 planks)';
  await gotoNear(ctx, block.position.x, block.position.y, block.position.z, 2, 30_000);
  ctx.memory.setPlace('chest', block.position);
  return { block };
}

export async function chestStoreSkill(ctx: SkillContext, a: SkillArgsOf<'chest_store'>): Promise<string> {
  const { bot } = ctx;
  const found = await openNearestChest(ctx);
  if (typeof found === 'string') return found;
  const chest = await bot.openContainer(found.block);
  const done: string[] = [];
  try {
    for (const spec of a.items) {
      const { name, count } = parseItemSpec(spec);
      const names = [...new Set(bot.inventory.items().filter((i) => (name === 'all' ? true : i.name === name)).map((i) => i.name))];
      if (names.length === 0) done.push(`no ${name} in inventory`);
      for (const n of names) {
        const have = invCount(ctx, n);
        const inChestBefore = chestCount(chest, n);
        try {
          await chest.deposit(bot.registry.itemsByName[n]!.id, null, Math.min(have, count ?? have));
        } catch (e) {
          done.push(`failed ${n}: ${(e as Error).message}`);
        }
        await sleep(250);
        const moved = chestCount(chest, n) - inChestBefore; // what really arrived in the chest
        if (moved > 0) done.push(`${moved} ${n}`);
      }
    }
    rememberChest(ctx, found.block, chest.containerItems());
  } finally {
    chest.close();
  }
  const stored = done.filter((d) => /^\d/.test(d));
  const problems = done.filter((d) => !/^\d/.test(d));
  if (!stored.length) return `stored nothing${problems.length ? ` (${problems.join('; ')})` : ''}`;
  const c = found.block.position;
  bot.chat(`Stored ${stored.join(', ')} in the chest at ${c.x} ${c.y} ${c.z}`); // others nearby hear where things are
  return `stored ${stored.join(', ')} in chest ${fmtPos(found.block.position)}${problems.length ? ` (${problems.join('; ')})` : ''}`;
}

export async function chestTakeSkill(ctx: SkillContext, a: SkillArgsOf<'chest_take'>): Promise<string> {
  const { bot } = ctx;
  const found = await openNearestChest(ctx);
  if (typeof found === 'string') return found;
  const chest = await bot.openContainer(found.block);
  const done: string[] = [];
  let left = '';
  try {
    const contents = chest.containerItems();
    for (const spec of a.items) {
      const { name, count } = parseItemSpec(spec);
      if (name === 'list' || name === '?') continue;
      const inChest = contents.filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
      if (!inChest) {
        done.push(`no ${name} in chest`);
        continue;
      }
      try {
        await chest.withdraw(bot.registry.itemsByName[name]!.id, null, Math.min(count ?? inChest, inChest));
      } catch (e) {
        done.push(`failed ${name}: ${(e as Error).message}`);
      }
      await sleep(250);
      const got = inChest - chestCount(chest, name); // what really left the chest
      if (got > 0) done.push(`took ${got} ${name}`);
    }
    const now = chest.containerItems();
    rememberChest(ctx, found.block, now);
    left = now.length ? now.map((i) => `${i.count} ${i.name}`).join(', ') : 'nothing';
  } finally {
    chest.close();
  }
  const took = done.filter((d) => d.startsWith('took '));
  const c = found.block.position;
  if (took.length) bot.chat(`${took.join(', ').replace(/^took/, 'Took')} from the chest at ${c.x} ${c.y} ${c.z}`);
  return `${done.join('; ') || 'looked inside'}. Chest ${fmtPos(found.block.position)} now has: ${left}`;
}

export async function giveSkill(ctx: SkillContext, a: SkillArgsOf<'give'>): Promise<string> {
  const { bot } = ctx;
  const player = nearestEntity(ctx, a.player, 48);
  if (!player) return `${a.player} not nearby`;
  const item = bot.inventory.items().find((i) => i.name === a.item.toLowerCase());
  if (!item) return `no ${a.item} in inventory`;
  await gotoNear(ctx, player.position.x, player.position.y, player.position.z, 2, 30_000);
  await bot.lookAt(player.position.offset(0, 1.6, 0), true);
  const n = Math.min(item.count, a.count);
  await bot.toss(item.type, null, n);
  return `tossed ${n} ${item.name} to ${a.player}`;
}
