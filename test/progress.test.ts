import { describe, expect, it } from 'vitest';
import { milestones, progressText, type ProgressFacts } from '../src/bot/progress.js';

const empty: ProgressFacts = {
  items: {}, foodCount: 0, tableNearby: false, homeKnown: false, bedKnown: false, spareBedKnown: false,
};
const next = (f: ProgressFacts): string | undefined => milestones(f).find((m) => !m.done)?.id;

describe('progress ladder', () => {
  it('starts with wood', () => {
    expect(next(empty)).toBe('wood');
    expect(progressText(empty)).toContain('"block":"log","count":8');
  });
  it('walks the tech tree in order', () => {
    expect(next({ ...empty, items: { spruce_log: 8 } })).toBe('table');
    expect(next({ ...empty, items: { spruce_log: 6, crafting_table: 1 } })).toBe('wooden_pickaxe');
    expect(next({ ...empty, tableNearby: true, items: { wooden_pickaxe: 1, spruce_planks: 4 } })).toBe('sword');
    // shelter comes before better tools
    expect(next({ ...empty, tableNearby: true, items: { wooden_pickaxe: 1, wooden_sword: 1 } })).toBe('food');
    expect(next({ ...empty, tableNearby: true, foodCount: 5, items: { wooden_pickaxe: 1, wooden_sword: 1, dirt: 70 } })).toBe('shelter');
    expect(next({ ...empty, tableNearby: true, foodCount: 5, homeKnown: true, items: { wooden_pickaxe: 1, wooden_sword: 1, torch: 4 } })).toBe("stone_pickaxe");
  });
  it('asks for missing cobblestone before a stone pickaxe', () => {
    const f = { ...empty, tableNearby: true, foodCount: 5, homeKnown: true, items: { wooden_pickaxe: 1, wooden_sword: 1, cobblestone: 1, torch: 4 } };
    expect(progressText(f)).toContain('need 2 more cobblestone');
    expect(progressText({ ...f, items: { ...f.items, cobblestone: 3 } })).toContain('"item":"stone_pickaxe"');
  });
  it('wood stays done once tools exist, even with no logs left', () => {
    const f = { ...empty, tableNearby: true, items: { stone_pickaxe: 1, stone_sword: 1 } };
    expect(milestones(f).find((m) => m.id === 'wood')!.done).toBe(true);
    expect(next(f)).toBe('food');
  });
  it('beds come last and need wool', () => {
    const f: ProgressFacts = {
      items: { stone_pickaxe: 1, stone_sword: 1, torch: 4, white_wool: 1 }, foodCount: 6, tableNearby: true,
      homeKnown: true, bedKnown: false, spareBedKnown: false,
    };
    expect(next(f)).toBe('own_bed');
    expect(progressText(f)).toContain('need 2 more wool');
    expect(next({ ...f, bedKnown: true })).toBe('spare_bed');
    expect(next({ ...f, bedKnown: true, spareBedKnown: true })).toBeUndefined();
    expect(progressText({ ...f, bedKnown: true, spareBedKnown: true })).toContain('All basics done');
  });
});

describe('hunger override', () => {
  it('puts food first when hungry with nothing to eat', () => {
    const f: ProgressFacts = { ...empty, hunger: 8, items: { spruce_log: 2 } };
    expect(progressText(f)).toContain('NEXT STEP (FOOD - you are hungry (8/20)');
    expect(progressText({ ...f, hunger: 16 })).toContain('NEXT STEP (wood');
  });
});

describe('bed claiming', () => {
  it('suggests claiming a nearby bed before crafting one', () => {
    const f: ProgressFacts = {
      items: { stone_pickaxe: 1, stone_sword: 1, torch: 4 }, foodCount: 6, tableNearby: true,
      homeKnown: true, bedKnown: false, spareBedKnown: false, bedNear: { x: 1, y: 64, z: 2 },
    };
    expect(progressText(f)).toContain('there is a bed at 1,64,2');
  });
});

describe('underground', () => {
  it('tells a bot in a cave to go to the surface before getting wood', () => {
    expect(progressText({ ...empty, underground: true })).toContain('"skill":"go_surface"');
    expect(progressText({ ...empty })).not.toContain('go_surface');
  });
});

import { seasonOutlook } from '../src/bot/observation.js';

describe('season outlook', () => {
  it('warns when winter is close', () => {
    expect(seasonOutlook('AUTUMN', 12, 14)).toContain('WINTER IS COMING');
    expect(seasonOutlook('AUTUMN', 2, 14)).not.toContain('WINTER IS COMING');
    expect(seasonOutlook('SUMMER', 9, 14)).toBe('Calendar: day 9/14 of SUMMER, AUTUMN in 6 day(s).');
  });
});
