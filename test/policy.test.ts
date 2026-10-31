import { describe, expect, it } from 'vitest';
import { assignTier, assignTiers, decideSpawn, nextBotName } from '../src/lifecycle/policy.js';

const bed = { x: 1, y: 64, z: 2, world: 'world' };
const base = { maxBots: 8, initialBots: 2, reseedWhenExtinct: true, everSpawned: true };

describe('decideSpawn', () => {
  it('seeds initial bots on first start', () => {
    expect(decideSpawn({ ...base, aliveCount: 0, everSpawned: false })).toEqual({ action: 'seed', count: 2, reason: 'initial_seed' });
  });
  it('reseeds after extinction only when enabled', () => {
    expect(decideSpawn({ ...base, aliveCount: 0 }).action).toBe('seed');
    expect(decideSpawn({ ...base, aliveCount: 0, reseedWhenExtinct: false })).toEqual({ action: 'none', reason: 'extinct' });
  });
  it('caps seed count at maxBots', () => {
    expect(decideSpawn({ ...base, maxBots: 1, aliveCount: 0, everSpawned: false })).toMatchObject({ count: 1 });
  });
  it('never exceeds maxBots', () => {
    const canSpawn = { canSpawn: true, freeValidBed: bed, missing: [], reason: 'ok' };
    expect(decideSpawn({ ...base, aliveCount: 8, canSpawn })).toEqual({ action: 'none', reason: 'max_bots' });
  });
  it('needs the bridge', () => {
    expect(decideSpawn({ ...base, aliveCount: 2 })).toEqual({ action: 'none', reason: 'bridge_unavailable' });
  });
  it('respects the bridge rule', () => {
    const no = { canSpawn: false, freeValidBed: null, missing: ['Surv_02'], reason: 'bots_without_valid_bed' };
    expect(decideSpawn({ ...base, aliveCount: 2, canSpawn: no })).toEqual({ action: 'none', reason: 'bots_without_valid_bed' });
    const yes = { canSpawn: true, freeValidBed: bed, missing: [], reason: 'ok' };
    expect(decideSpawn({ ...base, aliveCount: 2, canSpawn: yes })).toEqual({ action: 'spawn', bed, reason: 'shelter_rule_met' });
  });
  it('treats canSpawn=true without a bed as no', () => {
    const odd = { canSpawn: true, freeValidBed: null, missing: [], reason: 'ok' };
    expect(decideSpawn({ ...base, aliveCount: 1, canSpawn: odd }).action).toBe('none');
  });
});

describe('tiers', () => {
  it('fills smart slots first', () => {
    expect(assignTier([], 2)).toBe('smart');
    expect(assignTier(['smart'], 2)).toBe('smart');
    expect(assignTier(['smart', 'smart'], 2)).toBe('basic');
  });
  it('a dead smart bot frees its slot for the next newborn (basic bots are not promoted)', () => {
    // Living: one smart (the other smart died), three basic.
    expect(assignTier(['smart', 'basic', 'basic', 'basic'], 2)).toBe('smart');
  });
  it('never exceeds smartSlots', () => {
    expect(assignTiers([], 2, 5)).toEqual(['smart', 'smart', 'basic', 'basic', 'basic']);
    expect(assignTiers([], 0, 2)).toEqual(['basic', 'basic']);
  });
});

describe('nextBotName', () => {
  it('pads and never reuses names', () => {
    expect(nextBotName('Surv_', 0, new Set())).toEqual({ name: 'Surv_01', counter: 1 });
    expect(nextBotName('Surv_', 1, new Set(['surv_02']))).toEqual({ name: 'Surv_03', counter: 3 });
    expect(nextBotName('Surv_', 99, new Set()).name).toBe('Surv_100');
  });
});
