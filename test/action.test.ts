import { describe, expect, it } from 'vitest';
import { fallbackAction, parseAction } from '../src/bot/action.js';
import { extractJsonObject } from '../src/util/json.js';

describe('extractJsonObject', () => {
  it('handles plain, fenced and prose-wrapped JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure!\n```json\n{"a":2}\n```\nhope it helps')).toEqual({ a: 2 });
    expect(extractJsonObject('I will do {"a":{"b":"}"}} now')).toEqual({ a: { b: '}' } });
  });
  it('repairs trailing commas', () => {
    expect(extractJsonObject('{"a":1,}')).toEqual({ a: 1 });
  });
  it('returns undefined when nothing is found', () => {
    expect(extractJsonObject('no json here')).toBeUndefined();
  });
});

describe('parseAction', () => {
  it('accepts a valid action and applies defaults/coercion', () => {
    const r = parseAction('{"thought":"need wood","skill":"gather","args":{"block":"log","count":"5"}}', 'basic');
    expect(r).toEqual({ ok: true, action: { thought: 'need wood', skill: 'gather', args: { block: 'log', count: 5 } } });
    const d = parseAction('{"skill":"explore"}', 'basic');
    expect(d.ok && d.action.args).toEqual({ distance: 40 });
  });
  it('tolerates "action" key and inlined args', () => {
    const r = parseAction('{"action":"say","text":"hello"}', 'basic');
    expect(r.ok && r.action).toMatchObject({ skill: 'say', args: { text: 'hello' } });
  });
  it('rejects unknown skills and invalid args', () => {
    expect(parseAction('{"skill":"fly"}', 'smart')).toMatchObject({ ok: false });
    const bad = parseAction('{"skill":"gather","args":{"count":3}}', 'smart');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/block/);
  });
  it('enforces tier subsets', () => {
    expect(parseAction('{"skill":"set_goal","args":{"text":"x"}}', 'basic')).toMatchObject({ ok: false });
    expect(parseAction('{"skill":"set_goal","args":{"text":"x"}}', 'smart').ok).toBe(true);
  });
  it('validates goto needs coords or place', () => {
    expect(parseAction('{"skill":"goto","args":{}}', 'basic').ok).toBe(false);
    expect(parseAction('{"skill":"goto","args":{"place":"home"}}', 'basic').ok).toBe(true);
    expect(parseAction('{"skill":"goto","args":{"x":1,"y":2,"z":3}}', 'basic').ok).toBe(true);
  });
  it('splits comma item lists', () => {
    const r = parseAction('{"skill":"chest_store","args":{"items":"dirt, oak_log:4"}}', 'basic');
    expect(r.ok && r.action.args.items).toEqual(['dirt', 'oak_log:4']);
  });
  it('fallback prefers wood when poor', () => {
    expect(fallbackAction(0).skill).toBe('gather');
    expect(fallbackAction(20).skill).toBe('explore');
  });
});

import { looksFailed, parsePlan } from '../src/bot/action.js';

describe('multi-step plans', () => {
  it('parses a smart plan of up to 5 steps', () => {
    const r = parsePlan(
      JSON.stringify({
        thought: 'shelter first',
        plan: [
          { skill: 'gather', args: { block: 'dirt', count: 40 } },
          { skill: 'build_shelter', args: { size: 5 } },
          { skill: 'place_torch', args: {} },
        ],
      }),
      'smart',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.steps.map((s) => s.skill)).toEqual(['gather', 'build_shelter', 'place_torch']);
      expect(r.steps[0]!.thought).toBe('shelter first');
    }
  });
  it('caps smart plans at 5 steps and basic plans at 1', () => {
    const plan = Array.from({ length: 8 }, () => ({ skill: 'eat', args: {} }));
    const smart = parsePlan(JSON.stringify({ plan }), 'smart');
    const basic = parsePlan(JSON.stringify({ plan }), 'basic');
    expect(smart.ok && smart.steps.length).toBe(5);
    expect(basic.ok && basic.steps.length).toBe(1);
  });
  it('accepts a single action as a one-step plan', () => {
    const r = parsePlan('{"thought":"x","skill":"eat","args":{}}', 'basic');
    expect(r.ok && r.steps.length).toBe(1);
  });
  it('rejects a plan with an invalid step, naming the step', () => {
    const r = parsePlan(JSON.stringify({ plan: [{ skill: 'eat' }, { skill: 'fly', args: {} }] }), 'smart');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('plan step 2');
  });
  it('detects failed results', () => {
    expect(looksFailed('cannot craft stick: need 2 more planks')).toBe(true);
    expect(looksFailed('timed out after 120s')).toBe(true);
    expect(looksFailed('gathered 8 log (wanted 8)')).toBe(false);
    expect(looksFailed('crafted 1 wooden_pickaxe (now have 1)')).toBe(false);
  });
});

describe('free speech in replies', () => {
  it('extracts an optional say line and keeps it out of args', () => {
    const r = parsePlan('{"thought":"t","say":"I found iron at 10 60 5","skill":"gather","block":"log","count":4}', 'basic');
    expect(r.ok && r.say).toBe('I found iron at 10 60 5');
    expect(r.ok && r.steps[0]!.args).toEqual({ block: 'log', count: 4 });
    const p = parsePlan('{"say":"/op me","plan":[{"skill":"eat","args":{}}]}', 'smart');
    expect(p.ok && p.say).toBe('op me');
  });
});

describe('conclusions', () => {
  it('extracts "learned" and keeps it out of args', () => {
    const r = parsePlan('{"thought":"t","learned":"cows live on grass, not in caves","skill":"explore","direction":"north"}', 'basic');
    expect(r.ok && r.learned).toBe('cows live on grass, not in caves');
    expect(r.ok && r.steps[0]!.args).toMatchObject({ direction: 'north' });
    expect(parsePlan('{"learned":"x","skill":"eat"}', 'basic').ok && (parsePlan('{"learned":"x","skill":"eat"}', 'basic') as { learned?: string }).learned).toBeUndefined();
  });
});

import { parsePlan as pp } from '../src/bot/action.js';
describe('item name cleanup', () => {
  it('strips counts and namespaces', () => {
    const r = pp('{"thought":"t","skill":"smelt","args":{"item":"raw_iron:3"}}', 'smart');
    expect(r.ok && r.steps[0]!.args).toMatchObject({ item: 'raw_iron', count: 3 });
    const g = pp('{"thought":"t","skill":"gather","args":{"block":"minecraft:oak_log","count":4}}', 'smart');
    expect(g.ok && g.steps[0]!.args).toMatchObject({ block: 'oak_log', count: 4 });
  });
});
