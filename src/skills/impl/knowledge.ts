import type { Item } from 'prismarine-item';
import { sleep } from '../../util/time.js';
import { readBookItem, wrapSignText, type BookLike } from '../bookText.js';
import type { SkillArgsOf } from '../schemas.js';
import type { SkillContext } from '../context.js';
import { findBlocks, findItem, fmtPos, freeSpotNearBot, gotoNear, nearestBlock, placeItemAt } from '../helpers.js';
import { craftSkill } from './resources.js';
import { SHOUT_PREFIX, wordCount } from '../../bot/chat.js';

/** signBook exists at runtime in mineflayer 4.x but is missing from its typings. */
interface BookBot {
  signBook?: (slot: number, pages: string[], author: string, title: string) => Promise<void>;
}

export async function checkTemperatureSkill(ctx: SkillContext): Promise<string> {
  if (!ctx.seasons.enabled) return 'seasons/temperature not available on this server';
  const p = ctx.bot.entity.position;
  const [t, r] = await Promise.all([ctx.seasons.temp(p.x, p.y, p.z), ctx.seasons.room(p.x, p.y, p.z)]);
  if (!t) return 'temperature unknown';
  const room = r ?? t;
  return `season ${t.season}, here ${t.tempC.toFixed(1)}C (outside ${t.outsideC.toFixed(1)}C), ${t.comfortable ? 'comfortable' : 'NOT comfortable'}; ` +
    (room.inside ? `inside room vol ${room.volume}, ${room.sealed ? 'sealed' : `LEAKING (small ${room.leaks.small}, large ${room.leaks.large})`}` : 'outdoors');
}

export async function saySkill(ctx: SkillContext, a: SkillArgsOf<'say'>): Promise<string> {
  ctx.bot.chat(a.text.replace(/^\//, '').slice(0, 240));
  return 'said it (only players within chat range hear)';
}

/** Per-bot time of the last shout (cooldown is per bot name, survives skill calls). */
const lastShout = new Map<string, number>();

/** Seconds until `name` may shout again (0 = ready). */
export function shoutCooldownLeft(name: string, cooldownSeconds: number, now = Date.now()): number {
  const last = lastShout.get(name);
  if (last === undefined) return 0;
  return Math.max(0, Math.ceil(cooldownSeconds - (now - last) / 1000));
}

export async function shoutSkill(ctx: SkillContext, a: SkillArgsOf<'shout'>): Promise<string> {
  const { maxWords, cooldownSeconds } = ctx.config.shout;
  const text = a.text.replace(/^\//, '').replace(/\s+/g, ' ').trim();
  const words = wordCount(text);
  if (words > maxWords) return `too long: ${words} words, a shout may have at most ${maxWords}. Shorten it.`;
  const wait = shoutCooldownLeft(ctx.name, cooldownSeconds);
  if (wait > 0) return `shout on cooldown, ${wait}s left (use say for nearby players)`;
  lastShout.set(ctx.name, Date.now());
  ctx.bot.chat(`${SHOUT_PREFIX}${text}`.slice(0, 250));
  return `shouted (heard up to ${ctx.config.shout.range} blocks; listeners see you at ${fmtPos(ctx.bot.entity.position)})`;
}

const PROTECTED_PLACES = new Set(['bed', 'spare_bed']);

export async function markPlaceSkill(ctx: SkillContext, a: SkillArgsOf<'mark_place'>): Promise<string> {
  const key = a.name.trim().toLowerCase().replace(/\s+/g, '_');
  if (PROTECTED_PLACES.has(key)) return `"${key}" is set automatically when you place/claim a bed; pick another name`;
  const p = ctx.bot.entity.position.floored();
  ctx.memory.setPlace(key, p);
  return `marked "${key}" at ${fmtPos(p)}; go back with goto {"place":"${key}"}`;
}

export async function writeSignSkill(ctx: SkillContext, a: SkillArgsOf<'write_sign'>): Promise<string> {
  const { bot } = ctx;
  let sign = findItem(bot, /^(?!.*hanging).*_sign$/);
  if (!sign) {
    const planks = findItem(bot, /_planks$/);
    const name = planks ? planks.name.replace(/_planks$/, '_sign') : 'oak_sign';
    const r = await craftSkill(ctx, { item: name, count: 3 });
    if (!r.startsWith('crafted')) return `no sign: ${r}`;
    sign = findItem(bot, /^(?!.*hanging).*_sign$/);
  }
  const spot = freeSpotNearBot(bot);
  if (!sign || !spot) return 'no spot for a sign';
  if (!(await placeItemAt(ctx, sign, spot))) return 'failed to place sign';
  await sleep(300);
  const block = bot.blockAt(spot);
  if (!block || !block.name.endsWith('_sign')) return 'sign did not appear';
  bot.updateSign(block, wrapSignText(a.text).join('\n'));
  ctx.memory.addNote(`Wrote sign at ${fmtPos(spot)}: ${a.text}`);
  return `wrote sign at ${fmtPos(spot)}`;
}

export async function readSignsSkill(ctx: SkillContext, a: SkillArgsOf<'read_signs'>): Promise<string> {
  const { bot } = ctx;
  const names = Object.keys(bot.registry.blocksByName).filter((n) => n.endsWith('_sign'));
  const blocks = findBlocks(bot, names, a.radius, 12);
  if (blocks.length === 0) return 'no signs nearby';
  const out: string[] = [];
  for (const b of blocks) {
    try {
      const [front, back] = b.getSignText();
      const text = [front, back].filter((t) => t && t.trim()).map((t) => t!.replace(/\n+/g, ' ').trim()).join(' / ');
      if (text) out.push(`(${fmtPos(b.position)}) "${text}"`);
    } catch {
      /* unreadable */
    }
  }
  return out.length ? `signs: ${out.join('; ')}` : 'signs nearby are blank';
}

export async function writeBookSkill(ctx: SkillContext, a: SkillArgsOf<'write_book'>): Promise<string> {
  const { bot } = ctx;
  const book = findItem(bot, 'writable_book');
  if (!book) return 'need a writable_book (book + ink_sac + feather)';
  const signBook = (bot as unknown as BookBot).signBook;
  if (signBook) {
    await signBook.call(bot, book.slot, a.pages, ctx.name, a.title.slice(0, 32));
    ctx.memory.addNote(`Wrote book "${a.title}". Store it in a chest or lectern to share.`);
    return `wrote and signed book "${a.title}" (${a.pages.length} pages)`;
  }
  await bot.writeBook(book.slot, a.pages);
  return `wrote ${a.pages.length} pages (signing unsupported by this mineflayer version)`;
}

function describeBook(item: Item): string {
  const c = readBookItem(item as unknown as BookLike);
  if (!c || c.pages.length === 0) return 'book is empty or unreadable';
  const pages = c.pages.map((p, i) => `[${i + 1}] ${p.slice(0, 300)}`).join(' ');
  return `${c.title ? `"${c.title}"` : 'book'}${c.author ? ` by ${c.author}` : ''}: ${pages}`.slice(0, 1500);
}

export async function readBookSkill(ctx: SkillContext, a: SkillArgsOf<'read_book'>): Promise<string> {
  const { bot } = ctx;
  if (a.source === 'lectern') {
    const lectern = nearestBlock(bot, ['lectern'], 24);
    if (!lectern) return 'no lectern nearby';
    await gotoNear(ctx, lectern.position.x, lectern.position.y, lectern.position.z, 2, 30_000);
    const win = await bot.openBlock(lectern);
    try {
      const item = win.slots[0];
      return item ? describeBook(item) : 'lectern is empty';
    } finally {
      bot.closeWindow(win);
    }
  }
  const item = a.slot !== undefined ? bot.inventory.slots[a.slot] : (findItem(bot, 'written_book') ?? findItem(bot, 'writable_book'));
  if (!item || !/book/.test(item.name)) return 'no book in inventory (chest_take one first)';
  return describeBook(item);
}

export async function rememberSkill(ctx: SkillContext, a: SkillArgsOf<'remember'>): Promise<string> {
  ctx.memory.addNote(a.note);
  return 'noted';
}

export async function setGoalSkill(ctx: SkillContext, a: SkillArgsOf<'set_goal'>): Promise<string> {
  ctx.memory.setGoal(a.text);
  return `goal set: ${a.text}`;
}

export async function waitSkill(ctx: SkillContext, a: SkillArgsOf<'wait'>): Promise<string> {
  await sleep(a.seconds * 1000, ctx.signal);
  return `waited ${a.seconds}s`;
}
