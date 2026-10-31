import type { Bot } from 'mineflayer';
import type { SeasonsReading } from '../contracts.js';
import type { Tier } from '../lifecycle/policy.js';
import { findBlocks, fmtPos, HOSTILE_MOBS } from '../skills/helpers.js';
import type { HeardMessage } from './chat.js';
import type { Memory } from './memory.js';
import { progressText } from './progress.js';

export interface ObservationInput {
  bot: Bot;
  name: string;
  tier: Tier;
  memory: Memory;
  scanRadius: number;
  temp?: SeasonsReading;
  seasonsEnabled: boolean;
  heard: readonly HeardMessage[];
  recentResults: readonly string[];
  interruptedBy?: string;
}

const CATEGORIES: Array<[string, (n: string) => boolean]> = [
  ['logs', (n) => n.endsWith('_log') && !n.startsWith('stripped_')],
  ['coal_ore', (n) => n === 'coal_ore' || n === 'deepslate_coal_ore'],
  ['iron_ore', (n) => n === 'iron_ore' || n === 'deepslate_iron_ore'],
  ['copper_ore', (n) => n === 'copper_ore'],
  ['gold_ore', (n) => n === 'gold_ore'],
  ['diamond_ore', (n) => n === 'diamond_ore' || n === 'deepslate_diamond_ore'],
  ['water', (n) => n === 'water'],
  ['lava', (n) => n === 'lava'],
  ['sand', (n) => n === 'sand'],
  ['clay', (n) => n === 'clay'],
  ['beds', (n) => n.endsWith('_bed')],
  ['chest', (n) => n === 'chest' || n === 'barrel'],
  ['signs', (n) => n.endsWith('_sign')],
  ['crafting_table', (n) => n === 'crafting_table'],
  ['furnace', (n) => n === 'furnace'],
  ['lectern', (n) => n === 'lectern'],
  ['farmland', (n) => n === 'farmland'],
  ['crops', (n) => ['wheat', 'carrots', 'potatoes', 'beetroots'].includes(n)],
];

function timeLabel(bot: Bot): string {
  const t = bot.time.timeOfDay;
  const phase = t < 1000 ? 'sunrise' : t < 12000 ? 'day' : t < 13000 ? 'sunset' : t < 23000 ? 'NIGHT' : 'dawn';
  return `${phase} (${t})`;
}

export function inventorySummary(bot: Bot): string {
  const counts = new Map<string, number>();
  for (const i of bot.inventory.items()) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  if (counts.size === 0) return 'empty';
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${c} ${n}`)
    .join(', ');
}

export function buildObservation(o: ObservationInput): string {
  const { bot, memory } = o;
  const me = bot.entity.position;
  const lines: string[] = [];
  lines.push(`You: ${o.name} (${o.tier}). Health ${Math.round(bot.health)}/20, Food ${bot.food}/20. Pos ${fmtPos(me)}. Time ${timeLabel(bot)}${bot.isRaining ? ', raining' : ''}.`);
  if (o.seasonsEnabled && o.temp) {
    const t = o.temp;
    lines.push(
      `Season ${t.season}. Here ${t.tempC.toFixed(1)}C, outside ${t.outsideC.toFixed(1)}C, ${t.comfortable ? 'comfortable' : 'UNCOMFORTABLE'}${t.inside ? `, indoors (${t.sealed ? 'sealed' : 'leaky'})` : ', outdoors'}.`,
    );
  } else if (!o.seasonsEnabled) {
    lines.push('Seasons: not available on this server.');
  }
  lines.push(`Goal: ${memory.data.goal ?? '(none)'}`);
  lines.push(`Inventory: ${inventorySummary(bot)}. Holding: ${bot.heldItem?.name ?? 'nothing'}.`);
  lines.push(progressFor(o));

  const notable: string[] = [];
  const allNames = Object.keys(bot.registry.blocksByName);
  for (const [label, pred] of CATEGORIES) {
    const names = allNames.filter(pred);
    const found = findBlocks(bot, names, o.scanRadius, 32);
    if (found.length === 0) continue;
    const nearest = found[0]!;
    notable.push(`${label} x${found.length >= 32 ? '32+' : found.length} (nearest ${fmtPos(nearest.position)})`);
  }
  lines.push(`Nearby blocks (r${o.scanRadius}): ${notable.join('; ') || 'nothing notable'}.`);

  const mobs: string[] = [];
  const players: string[] = [];
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position) continue;
    const d = e.position.distanceTo(me);
    if (d > o.scanRadius) continue;
    if (e.type === 'player' && e.username) players.push(`${e.username} ${d.toFixed(0)}m`);
    else if (e.name && e.type !== 'object' && e.type !== 'orb' && e.type !== 'projectile' && e.type !== 'player') {
      mobs.push(`${HOSTILE_MOBS.has(e.name) ? '!' : ''}${e.name} ${d.toFixed(0)}m`);
    }
  }
  lines.push(`Players near: ${players.join(', ') || 'none'}. Mobs near (! = hostile): ${mobs.slice(0, 10).join(', ') || 'none'}.`);

  if (o.heard.length) {
    lines.push('Heard recently:');
    for (const h of o.heard.slice(-6)) lines.push(`  <${h.from}> ${h.text}`);
  }
  const places = Object.entries(memory.data.places).map(([k, p]) => `${k} ${fmtPos(p)}`);
  lines.push(`Known places: ${places.join('; ') || 'none'}.`);
  if (memory.data.notes.length) {
    lines.push('Your notes:');
    for (const n of memory.data.notes.slice(-12)) lines.push(`  - ${n}`);
  }
  if (o.recentResults.length) {
    lines.push('Last actions:');
    for (const r of o.recentResults.slice(-5)) lines.push(`  - ${r}`);
  }
  if (o.interruptedBy) lines.push(`(Your last action was interrupted by reflex: ${o.interruptedBy})`);
  return lines.join('\n');
}

function progressFor(o: ObservationInput): string {
  const { bot, memory } = o;
  const items: Record<string, number> = {};
  let foodCount = 0;
  for (const i of bot.inventory.items()) {
    items[i.name] = (items[i.name] ?? 0) + i.count;
    if (bot.registry.foodsByName[i.name] && !/rotten|spider_eye|poisonous/.test(i.name)) foodCount += i.count;
  }
  const t = o.temp;
  return progressText({
    items,
    foodCount,
    tableNearby: findBlocks(bot, ['crafting_table'], 24, 1).length > 0,
    homeKnown: !!memory.place('home'),
    bedKnown: !!memory.place('bed'),
    spareBedKnown: !!memory.place('spare_bed'),
    warmHome: o.seasonsEnabled && t ? (t.inside && t.sealed && t.comfortable ? true : undefined) : undefined,
  });
}
