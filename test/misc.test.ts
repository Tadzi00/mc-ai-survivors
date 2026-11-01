import { describe, expect, it } from 'vitest';
import { compactNotes } from '../src/bot/memory.js';
import { chooseReflex, type ReflexState } from '../src/bot/reflexChoice.js';
import { parseConfig, interpolateEnv } from '../src/config.js';
import { flattenText, readBookItem, wrapSignText } from '../src/skills/bookText.js';
import { readFileSync } from 'node:fs';

const calm: ReflexState = {
  health: 20, food: 20, oxygen: 20, hasFood: true, inLava: false, onFire: false, inWater: false,
  hasWeapon: false, isNight: false, isSleeping: false, bedKnown: false, hasTorch: false, homeKnown: false,
};

describe('reflex choice', () => {
  it('does nothing when calm', () => expect(chooseReflex(calm)).toBeNull());
  it('lava beats everything', () => expect(chooseReflex({ ...calm, inLava: true, food: 1 })).toBe('escape_lava'));
  it('surfaces when drowning', () => expect(chooseReflex({ ...calm, inWater: true, oxygen: 5 })).toBe('surface'));
  it('fights when healthy, flees when weak or vs creeper', () => {
    const z = { distance: 4, type: 'zombie' };
    expect(chooseReflex({ ...calm, hostile: z })).toBe('fight'); // full health, one mob, bare hands
    expect(chooseReflex({ ...calm, health: 6, hostile: z })).toBe('flee');
    expect(chooseReflex({ ...calm, hostile: { distance: 4, type: 'creeper' } })).toBe('flee');
  });
  it('bare-handed bots avoid risky fights; armed bots fight on', () => {
    const z = { distance: 4, type: 'zombie' };
    expect(chooseReflex({ ...calm, health: 14, hostile: z })).toBe('flee');
    expect(chooseReflex({ ...calm, hostile: z, nearbyHostiles: 2 })).toBe('flee');
    expect(chooseReflex({ ...calm, health: 12, hasWeapon: true, hostile: z })).toBe('fight');
    expect(chooseReflex({ ...calm, health: 12, hasWeapon: true, hostile: z, nearbyHostiles: 3 })).toBe('flee');
    expect(chooseReflex({ ...calm, health: 8, hasWeapon: true, hostile: z })).toBe('flee');
  });
  it('eats when hungry', () => expect(chooseReflex({ ...calm, food: 10 })).toBe('eat'));
  it('hunts when starving with no food, if prey is known', () => {
    expect(chooseReflex({ ...calm, hasFood: false, food: 6, preyKnown: true })).toBe('hunt');
    expect(chooseReflex({ ...calm, hasFood: false, food: 6, preyKnown: false })).toBeNull();
    expect(chooseReflex({ ...calm, hasFood: false, food: 12, preyKnown: true })).toBeNull();
    expect(chooseReflex({ ...calm, hasFood: true, food: 6, preyKnown: true })).toBe('eat');
  });
  it('takes shelter at night in the open; leaves the bunker by day', () => {
    expect(chooseReflex({ ...calm, isNight: true, nightExposed: true })).toBe('night_shelter');
    expect(chooseReflex({ ...calm, isNight: true, nightExposed: true, hostile: { distance: 4, type: 'zombie' } })).toBe('fight');
    expect(chooseReflex({ ...calm, bunkeredAtDay: true })).toBe('leave_bunker');
    expect(chooseReflex({ ...calm, isNight: true, nightExposed: false })).toBeNull();
  });
  it('runs to help a teammate when healthy, but own danger comes first', () => {
    expect(chooseReflex({ ...calm, helpCall: { distance: 60 } })).toBe('assist');
    expect(chooseReflex({ ...calm, helpCall: { distance: 60 }, health: 10 })).toBeNull();
    expect(chooseReflex({ ...calm, helpCall: { distance: 400 } })).toBeNull();
    expect(chooseReflex({ ...calm, helpCall: { distance: 3 } })).toBeNull();
    expect(chooseReflex({ ...calm, helpCall: { distance: 60 }, hostile: { distance: 4, type: 'zombie' } })).toBe('fight');
  });
  it('warms up when cold', () => {
    expect(chooseReflex({ ...calm, cold: true, homeKnown: true })).toBe('warm_home');
    expect(chooseReflex({ ...calm, cold: true, hasTorch: true })).toBe('warm_torch');
    expect(chooseReflex({ ...calm, cold: undefined, hasTorch: true })).toBeNull();
  });
  it('sleeps at night with a bed', () => expect(chooseReflex({ ...calm, isNight: true, bedKnown: true })).toBe('sleep'));
});

describe('memory compaction', () => {
  it('keeps notes bounded and merges oldest', () => {
    const notes = Array.from({ length: 11 }, (_, i) => `n${i}`);
    const c = compactNotes(notes, 10);
    expect(c.length).toBeLessThanOrEqual(10);
    expect(c[0]).toMatch(/^Older notes: n0 \| n1/);
    expect(c.at(-1)).toBe('n10');
  });
});

describe('books and signs', () => {
  it('flattens json/nbt text components', () => {
    expect(flattenText('{"text":"Hello ","extra":[{"text":"world"}]}')).toBe('Hello world');
    expect(flattenText({ type: 'string', value: 'plain' })).toBe('plain');
  });
  it('reads 1.21 written_book_content components', () => {
    const item = { componentMap: new Map([['written_book_content', { data: { rawTitle: 'Tips', author: 'Surv_01', pages: [{ content: { type: 'string', value: 'Build walls' } }] } }]]) };
    expect(readBookItem(item)).toEqual({ title: 'Tips', author: 'Surv_01', pages: ['Build walls'] });
  });
  it('wraps sign text into 4 lines of 15 chars', () => {
    const lines = wrapSignText('Home is north 40 blocks. Beds inside. Keep door closed!');
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.every((l) => l.length <= 15)).toBe(true);
  });
});

describe('config', () => {
  it('interpolates env vars with defaults and types', () => {
    expect(interpolateEnv({ a: '${P:-25565}', b: 'x${Q:-y}z', c: '${R}' }, { R: 'true' })).toEqual({ a: 25565, b: 'xyz', c: true });
  });
  it('example config is valid', () => {
    const cfg = parseConfig(readFileSync('config.example.yaml', 'utf8'), {});
    expect(cfg.population.maxBots).toBe(8);
    expect(cfg.population.smartSlots).toBe(2);
    expect(cfg.chatRange).toBe(15);
    expect(cfg.shout).toEqual({ range: 1000, maxWords: 15, cooldownSeconds: 60 });
    expect(cfg.tiers.smart.model).toBe('qwen2.5:7b');
  });
  it('rejects unknown tier provider', () => {
    expect(() => parseConfig('providers: {a: {type: ollama}}\ntiers: {smart: {provider: b, model: m}, basic: {provider: a, model: m}}', {})).toThrow(/unknown provider/);
  });
});

import { addDiscovery, addLesson, lessonFrom } from '../src/bot/memory.js';

describe('auto memory', () => {
  const d = (what: string, x: number) => ({ what, x, y: 60, z: 0, at: 't' });
  it('merges nearby discoveries of the same kind and caps the list', () => {
    let l = addDiscovery([], d('iron_ore', 0));
    l = addDiscovery(l, d('iron_ore', 10));
    expect(l).toHaveLength(1);
    l = addDiscovery(l, d('iron_ore', 100));
    l = addDiscovery(l, d('coal_ore', 5));
    expect(l.map((x) => x.what)).toEqual(['iron_ore', 'iron_ore', 'coal_ore']);
    let big: ReturnType<typeof addDiscovery> = [];
    for (let i = 0; i < 50; i++) big = addDiscovery(big, d('x', i * 100));
    expect(big).toHaveLength(40);
  });
  it('dedups lessons', () => {
    let l = addLesson([], 'gather iron_ore: need a better tool to harvest iron_ore (craft a pickaxe)');
    l = addLesson(l, 'gather iron_ore: need a better tool to harvest iron_ore (craft a stone pickaxe)');
    expect(l).toHaveLength(1);
  });
  it('turns failures into lessons, skips situational ones', () => {
    expect(lessonFrom('gather', { block: 'iron_ore' }, 'need a better tool to harvest iron_ore (craft a pickaxe)')).toBe(
      'gather iron_ore: need a better tool to harvest iron_ore (craft a pickaxe)',
    );
    expect(lessonFrom('attack', { target: 'cow' }, 'no cow within 24 blocks')).toBeUndefined();
    expect(lessonFrom('gather', { block: 'log' }, 'gathered 8 log (wanted 8)')).toBeUndefined();
  });
});

import { applyChestDelta, parseChestReport } from '../src/bot/memory.js';

describe('chest knowledge', () => {
  it('parses stored/took reports', () => {
    expect(parseChestReport('Stored 15 cobblestone, 5 bread in the chest at -11 99 -11')).toEqual({
      sign: 1, items: { cobblestone: 15, bread: 5 }, pos: { x: -11, y: 99, z: -11 },
    });
    expect(parseChestReport('Took 5 cobblestone from the chest at 3 64 -2')).toEqual({
      sign: -1, items: { cobblestone: 5 }, pos: { x: 3, y: 64, z: -2 },
    });
    expect(parseChestReport('I like chests')).toBeUndefined();
  });
  it('applies deltas without going negative', () => {
    expect(applyChestDelta({ cobblestone: 10 }, { cobblestone: 15, bread: 2 }, 1)).toEqual({ cobblestone: 25, bread: 2 });
    expect(applyChestDelta({ cobblestone: 10, bread: 2 }, { cobblestone: 10, bread: 5 }, -1)).toEqual({});
  });
});
