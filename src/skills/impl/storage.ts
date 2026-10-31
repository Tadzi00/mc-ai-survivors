import type { Block } from 'prismarine-block';
import type { SkillArgsOf } from '../schemas.js';
import type { SkillContext } from '../context.js';
import { fmtPos, gotoNear, nearestBlock } from '../helpers.js';
import { nearestEntity } from './survival.js';

function parseItemSpec(spec: string): { name: string; count?: number } {
  const [name, c] = spec.split(':');
  const count = c ? Number.parseInt(c, 10) : undefined;
  return { name: name!.trim().toLowerCase(), count: Number.isFinite(count) ? count : undefined };
}

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
      const matching = bot.inventory.items().filter((i) => (name === 'all' ? true : i.name === name));
      for (const it of matching) {
        const n = Math.min(it.count, count ?? it.count);
        try {
          await chest.deposit(it.type, null, n);
          done.push(`${n} ${it.name}`);
        } catch (e) {
          done.push(`failed ${it.name}: ${(e as Error).message}`);
        }
        if (count !== undefined) break;
      }
    }
  } finally {
    chest.close();
  }
  return done.length ? `stored ${done.join(', ')} at chest ${fmtPos(found.block.position)}` : 'nothing matching to store';
}

export async function chestTakeSkill(ctx: SkillContext, a: SkillArgsOf<'chest_take'>): Promise<string> {
  const { bot } = ctx;
  const found = await openNearestChest(ctx);
  if (typeof found === 'string') return found;
  const chest = await bot.openContainer(found.block);
  const done: string[] = [];
  try {
    const contents = chest.containerItems();
    for (const spec of a.items) {
      const { name, count } = parseItemSpec(spec);
      const it = contents.find((i) => i.name === name);
      if (!it) {
        done.push(`no ${name}`);
        continue;
      }
      const n = Math.min(count ?? it.count, contents.filter((i) => i.name === name).reduce((s, i) => s + i.count, 0));
      try {
        await chest.withdraw(it.type, null, n);
        done.push(`${n} ${name}`);
      } catch (e) {
        done.push(`failed ${name}: ${(e as Error).message}`);
      }
    }
    if (a.items.length === 0 || done.length === 0) {
      done.push(`chest has: ${contents.map((i) => `${i.count} ${i.name}`).join(', ') || 'nothing'}`);
    }
  } finally {
    chest.close();
  }
  return `took ${done.join(', ')}`;
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
