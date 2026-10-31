/**
 * Skill catalogue: argument schemas + which tier may use each skill. PURE (no mineflayer import)
 * so action validation is unit-testable. Implementations live in skills/impl/*.
 */
import { z } from 'zod';
import type { Tier } from '../lifecycle/policy.js';

const name = z.string().trim().min(1).max(64);
const num = z.coerce.number().finite();
const count = (def: number, max = 64) => z.coerce.number().int().min(1).max(max).default(def);
const itemList = z
  .union([z.array(z.string().min(1)).min(1), z.string().min(1)])
  .transform((v) => (Array.isArray(v) ? v : v.split(',').map((s) => s.trim()).filter(Boolean)));

export const SkillArgs = {
  gather: z.object({ block: name, count: count(8) }),
  craft: z.object({ item: name, count: count(1) }),
  smelt: z.object({ item: name, count: count(1), fuel: name.optional() }),
  goto: z
    .object({ x: num.optional(), y: num.optional(), z: num.optional(), place: name.optional() })
    .refine((a) => a.place !== undefined || (a.x !== undefined && a.z !== undefined), {
      message: 'give x,y,z coordinates or a remembered place name',
    }),
  explore: z.object({
    direction: z.enum(['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']).optional(),
    distance: z.coerce.number().int().min(8).max(128).default(40),
  }),
  follow: z.object({ player: name, seconds: z.coerce.number().int().min(3).max(120).default(30) }),
  attack: z.object({ target: name }),
  eat: z.object({}).passthrough(),
  sleep: z.object({}).passthrough(),
  place_block: z.object({ block: name, x: num.optional(), y: num.optional(), z: num.optional() }),
  build_shelter: z.object({ size: z.coerce.number().int().min(4).max(7).default(5) }),
  place_bed: z.object({}).passthrough(),
  place_torch: z.object({}).passthrough(),
  farm: z.object({
    action: z.enum(['till', 'plant', 'harvest']),
    crop: z.enum(['wheat', 'carrot', 'potato', 'beetroot']).default('wheat'),
  }),
  chest_store: z.object({ items: itemList }),
  chest_take: z.object({ items: itemList }),
  give: z.object({ player: name, item: name, count: count(1) }),
  check_temperature: z.object({}).passthrough(),
  say: z.object({ text: z.string().min(1).max(240) }),
  write_sign: z.object({ text: z.string().min(1).max(60) }),
  read_signs: z.object({ radius: z.coerce.number().int().min(1).max(32).default(16) }),
  write_book: z.object({
    title: z.string().min(1).max(32),
    pages: z.array(z.string().min(1).max(256)).min(1).max(10),
  }),
  read_book: z.object({
    slot: z.coerce.number().int().min(0).max(45).optional(),
    source: z.enum(['inventory', 'lectern']).default('inventory'),
  }),
  remember: z.object({ note: z.string().min(1).max(200) }),
  set_goal: z.object({ text: z.string().min(1).max(200) }),
  wait: z.object({ seconds: z.coerce.number().min(1).max(60).default(5) }),
} as const;

export type SkillName = keyof typeof SkillArgs;
export type SkillArgsOf<K extends SkillName> = z.infer<(typeof SkillArgs)[K]>;
export const SKILL_NAMES = Object.keys(SkillArgs) as SkillName[];

/** One-line usage shown to the model. */
export const SKILL_HELP: Record<SkillName, string> = {
  gather: 'gather {block,count} mine/chop blocks, e.g. block "log" (any wood), "stone", "iron_ore", "sand"',
  craft: 'craft {item,count} uses/places a crafting table automatically; makes planks/sticks if needed',
  smelt: 'smelt {item,count,fuel?} in a furnace, item = input or product (raw_iron or iron_ingot)',
  goto: 'goto {x,y,z} or {place} (a remembered place name like "home", "bed", "chest")',
  explore: 'explore {direction?,distance?} walk into unknown terrain',
  follow: 'follow {player,seconds}',
  attack: 'attack {target} mob type (e.g. "zombie", "cow") or player name',
  eat: 'eat {} eat best food in inventory',
  sleep: 'sleep {} sleep in own/nearby bed (by day: just claims the bed & sets spawn)',
  place_block: 'place_block {block,x?,y?,z?} place an item block (near you if no coords)',
  build_shelter: 'build_shelter {size 4-7} build a sealed room around you: walls, roof, door, torch. Needs ~70 blocks for size 5 + door + torch',
  place_bed: 'place_bed {} place a bed from inventory next to you (do it INSIDE a shelter)',
  place_torch: 'place_torch {} place a torch next to you (light + heat)',
  farm: 'farm {action:"till"|"plant"|"harvest",crop}',
  chest_store: 'chest_store {items:["oak_log:10","cobblestone"]} put items into nearest chest',
  chest_take: 'chest_take {items:[...]} take items from nearest chest',
  give: 'give {player,item,count} toss items to a nearby player',
  check_temperature: 'check_temperature {} temperature/season/room seal status at your position',
  say: 'say {text} chat; only players within the chat range hear it',
  write_sign: 'write_sign {text} place a sign with text (needs a sign item) - lasting public message',
  read_signs: 'read_signs {radius} read nearby signs',
  write_book: 'write_book {title,pages[]} write & sign a book (needs writable_book) - lasting knowledge',
  read_book: 'read_book {slot?,source:"inventory"|"lectern"}',
  remember: 'remember {note} save a note to your long-term memory',
  set_goal: 'set_goal {text} set your long-term goal',
  wait: 'wait {seconds}',
};

const SMART_ONLY: ReadonlySet<SkillName> = new Set(['set_goal', 'write_book', 'write_sign', 'smelt', 'place_block']);

export function skillsForTier(tier: Tier): SkillName[] {
  return tier === 'smart' ? [...SKILL_NAMES] : SKILL_NAMES.filter((s) => !SMART_ONLY.has(s));
}

export function isSkillName(s: string): s is SkillName {
  return Object.prototype.hasOwnProperty.call(SkillArgs, s);
}
