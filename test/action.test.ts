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
