import { describe, expect, it } from 'vitest';
import { looksLikeOrder, parseDirectCommand } from '../src/bot/orders.js';

describe('player orders', () => {
  const skills = (t: string) => parseDirectCommand(t, 'TAdzi00')?.steps.map((s) => s.skill);
  it('maps common commands to skills', () => {
    expect(skills('i gave you logs, build shelter')).toEqual(['build_shelter', 'place_torch']);
    expect(skills('build a house')).toEqual(['build_shelter', 'place_torch']);
    expect(skills('stop and wait')).toEqual(['wait']);
    expect(skills('come here')).toEqual(['follow']);
    expect(skills('follow me please')).toEqual(['follow']);
    expect(skills('go home')).toEqual(['goto']);
    expect(skills('go to sleep')).toEqual(['sleep']);
    expect(skills('eat something')).toEqual(['eat']);
  });
  it('follow targets the sender', () => {
    expect(parseDirectCommand('come here', 'TAdzi00')!.steps[0]!.args).toEqual({ player: 'TAdzi00', seconds: 60 });
  });
  it('leaves other messages to the model', () => {
    expect(parseDirectCommand('you have food', 'x')).toBeUndefined();
    expect(parseDirectCommand('where are you?', 'x')).toBeUndefined();
  });
  it('recognises instructions vs questions/statements', () => {
    expect(looksLikeOrder('gather 10 stone and bring it to me')).toBe(true);
    expect(looksLikeOrder("don't go into caves")).toBe(true);
    expect(looksLikeOrder('can you build a shelter?')).toBe(false);
    expect(looksLikeOrder('you have a torch')).toBe(false);
  });
});
