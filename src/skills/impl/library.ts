// The village library: a chest in the village with written books - the tribe's knowledge that outlives
// any single bot. library_write adds a book with this bot's best lessons and finds; library_read learns
// from every book in it (newborns do this right after being taught).
import type { Item } from 'prismarine-item';
import type { SkillContext } from '../context.js';
import { findItem, fmtPos, freeSpotNearBot, gotoNear, placeItemAt, v3 } from '../helpers.js';
import { readBookItem } from '../bookText.js';
import { topLessons } from '../../bot/society.js';
import { craftSkill } from './resources.js';
import { kindFromNews } from '../../bot/society.js';

/** Walk to the library chest (or make one in the village). */
async function libraryChest(ctx: SkillContext, create: boolean): Promise<{ x: number; y: number; z: number } | string> {
  const { bot } = ctx;
  const known = ctx.village?.data.library ?? ctx.memory.place('library');
  if (known && bot.blockAt(v3(known.x, known.y, known.z))?.name === 'chest') {
    await gotoNear(ctx, known.x, known.y, known.z, 2, 60_000).catch(() => undefined);
    return known;
  }
  if (!create) return 'there is no village library yet (library_write creates one: needs a book and quill)';
  const c = ctx.village?.center ?? ctx.memory.place('village') ?? ctx.memory.place('home');
  if (c) await gotoNear(ctx, c.x, c.y, c.z, 2, 60_000).catch(() => undefined);
  if (!findItem(bot, 'chest')) {
    const r = await craftSkill(ctx, { item: 'chest', count: 1 });
    if (!r.startsWith('crafted')) return `no library chest and cannot make one: ${r}`;
  }
  const spot = freeSpotNearBot(bot);
  const chest = findItem(bot, 'chest');
  if (!spot || !chest || !(await placeItemAt(ctx, chest, spot))) return 'could not place the library chest';
  ctx.village?.setLibrary(spot);
  ctx.memory.setPlace('library', { ...spot, note: 'village library (books)' });
  return spot;
}

/** library_write: write our best lessons and finds into a book and put it into the library chest. */
export async function libraryWriteSkill(ctx: SkillContext): Promise<string> {
  const { bot } = ctx;
  if (!findItem(bot, 'writable_book')) return 'need a book and quill (writable_book = book + ink_sac + feather) to write for the library';
  const lessons = topLessons(ctx.memory.data.lessons ?? [], 5);
  const finds = (ctx.memory.data.discoveries ?? [])
    .filter((d) => /iron|diamond|gold|coal|cows|sheeps|pigs|trees|danger/.test(d.what))
    .slice(-6)
    .map((d) => `${d.what.replace(/_/g, ' ')} at ${d.x} ${d.y} ${d.z}`);
  const pages = [...lessons, finds.length ? `Places: ${finds.join('; ')}` : ''].filter(Boolean).map((p) => p.slice(0, 250));
  if (!pages.length) return 'nothing worth writing yet (no lessons or finds)';
  const where = await libraryChest(ctx, true);
  if (typeof where === 'string') return where;
  const book = findItem(bot, 'writable_book')!;
  const signBook = (bot as unknown as { signBook?: (slot: number, pages: string[], author: string, title: string) => Promise<void> }).signBook;
  if (!signBook) return 'cannot write books on this client';
  await signBook.call(bot, book.slot, pages, ctx.name, `${ctx.name.replace(/^Surv_/, '')}'s knowledge`.slice(0, 32));
  await new Promise((r) => setTimeout(r, 600));
  const written = bot.inventory.items().find((i: Item) => i.name === 'written_book');
  if (!written) return 'writing the book failed';
  const block = bot.blockAt(v3(where.x, where.y, where.z));
  if (!block) return 'library chest not loaded';
  const chest = await bot.openContainer(block);
  try {
    await chest.deposit(written.type, null, 1);
  } finally {
    chest.close();
  }
  return `wrote "${ctx.name}'s knowledge" (${pages.length} pages) into the village library at ${fmtPos(where)}`;
}

/** library_read: read every book in the library chest and keep what is new. */
export async function libraryReadSkill(ctx: SkillContext): Promise<string> {
  const { bot } = ctx;
  const where = await libraryChest(ctx, false);
  if (typeof where === 'string') return where;
  const block = bot.blockAt(v3(where.x, where.y, where.z));
  if (!block) return 'library chest not loaded';
  const chest = await bot.openContainer(block);
  let learned = 0, books = 0;
  try {
    for (const it of chest.containerItems()) {
      if (it.name !== 'written_book') continue;
      const c = readBookItem(it as unknown as Parameters<typeof readBookItem>[0]);
      if (!c) continue;
      books++;
      for (const page of c.pages) {
        for (const part of page.split(/;\s*/)) {
          const coords = /(-?\d{1,6})[ ,]+(-?\d{1,4})[ ,]+(-?\d{1,6})/.exec(part);
          const kind = kindFromNews(part);
          if (coords && kind) {
            if (ctx.memory.discover(kind, { x: Number(coords[1]), y: Number(coords[2]), z: Number(coords[3]) })) learned++;
          } else if (part.trim().length > 12 && !/^Places:/.test(part) && learned < 12) {
            if (ctx.memory.learn(`Library (${c.author ?? '?'}): ${part.trim().slice(0, 150)}`)) learned++;
          }
        }
      }
    }
  } finally {
    chest.close();
  }
  ctx.memory.setPlace('library', { ...where, note: `village library (${books} books)` });
  return books ? `read ${books} book(s) in the village library, learned ${learned} new things` : 'the library chest has no books yet';
}
