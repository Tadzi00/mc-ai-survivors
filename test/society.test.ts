import { describe, expect, it } from 'vitest';
import { answerFrom, askedFor, cleanBotName, isChatter, kindFromNews, saidRecently, topLessons, whatToShare } from '../src/bot/society.js';
import { decideSpawn } from '../src/lifecycle/policy.js';
import type { MemoryData } from '../src/bot/memory.js';

const mem = (p: Partial<MemoryData>): MemoryData => ({ name: 'x', goal: null, notes: [], places: {}, ...p });

describe('society', () => {
  it('ranks lessons: player teaching and real failures before conclusions', () => {
    const t = topLessons(['Conclusion: cows live on grass', 'DEATH: x', 'Taught by TAdzi00: diamonds below y 16', 'At night in the open, dig 3 down', 'craft x: 3 more planks', 'Surv_1 is my mentor; ask'], 3);
    expect(t).toEqual(['diamonds below y 16', 'At night in the open, dig 3 down', 'Conclusion: cows live on grass']);
  });
  it('shares the village, valuable finds and one lesson the other lacks', () => {
    const teacher = mem({
      places: { village: { x: 1, y: 64, z: 2 } },
      discoveries: [{ what: 'water', x: 0, y: 0, z: 0, at: '' }, { what: 'iron_ore', x: 50, y: 40, z: 5, at: '' }],
      lessons: ['gather iron_ore: need a stone pickaxe'],
    });
    const items = whatToShare(teacher, mem({}), 3);
    expect(items.map((i) => i.kind)).toEqual(['place', 'discovery', 'discovery']);
    expect(items[1]!.text).toContain('iron ore');
    expect(whatToShare(teacher, teacher, 3)).toEqual([]);
  });
  it('spots chatter but keeps information', () => {
    expect(isChatter('Heading to gather 8 logs. Need wood.')).toBe(true);
    expect(isChatter("I'll build the shelter now")).toBe(true);
    expect(isChatter('Found iron at 120 40 -5!')).toBe(false);
    expect(isChatter('Anyone know where cows are?')).toBe(false);
    expect(saidRecently('Heading to gather logs now', [{ text: 'heading to gather logs', at: Date.now() }])).toBe(true);
  });
  it('questions and answers', () => {
    expect(askedFor('Anyone know where cows are?')).toEqual(['cows']);
    expect(askedFor('I like cows')).toEqual([]);
    const d = mem({ discoveries: [{ what: 'cows', x: 10, y: 64, z: 10, at: '' }, { what: 'cows', x: 500, y: 64, z: 500, at: '' }] });
    expect(answerFrom(['cows'], d, { x: 480, z: 480 })).toBe('cows at 500 64 500');
    expect(kindFromNews('Found iron at 120 40 -5')).toBe('iron_ore');
  });
  it('names: cleaned, prefixed, never reused', () => {
    const used = new Set(['Surv_01', 'Surv_Kira']);
    expect(cleanBotName('{"name":"Kiro"}', 'Surv_', used)).toBe('Surv_Kiro');
    const v = cleanBotName('{"name":"kira"}', 'Surv_', used)!;
    expect(v).toMatch(/^Surv_K/);
    expect(v.toLowerCase()).not.toBe('surv_kira');
    expect(cleanBotName('Marek, after our friend', 'Surv_', used)).toBe('Surv_Marek');
    expect(cleanBotName('{"name":"Bartholomewxyz"}', 'Surv_', used)).toBe('Surv_Bartholome');
  });
  it('birth limits', () => {
    const base = { aliveCount: 1, maxBots: 8, initialBots: 2, reseedWhenExtinct: true, everSpawned: true, canSpawn: { canSpawn: true, freeValidBed: { x: 0, y: 64, z: 0, world: 'w' }, missing: [] as string[], reason: '' } };
    expect(decideSpawn({ ...base, birthsToday: 2, maxBirthsPerDay: 2 }).reason).toBe('daily_birth_limit');
    expect(decideSpawn({ ...base, botNearBed: () => false }).reason).toBe('nobody_near_the_bed');
    expect(decideSpawn({ ...base, birthsToday: 1, maxBirthsPerDay: 2, botNearBed: () => true }).action).toBe('spawn');
  });
});
