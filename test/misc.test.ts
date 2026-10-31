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
    expect(cfg.chatRange).toBe(32);
    expect(cfg.tiers.smart.model).toBe('qwen2.5:7b');
  });
  it('rejects unknown tier provider', () => {
    expect(() => parseConfig('providers: {a: {type: ollama}}\ntiers: {smart: {provider: b, model: m}, basic: {provider: a, model: m}}', {})).toThrow(/unknown provider/);
  });
});
