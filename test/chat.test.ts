import { describe, expect, it } from 'vitest';
import { canHear, ChatLog, classifyChat, compass, formatHeard, Roster, SHOUT_PREFIX, wordCount } from '../src/bot/chat.js';

const me = { x: 0, y: 64, z: 0 };
const ranges = { say: 15, shout: 1000 };

describe('proximity chat', () => {
  it('canHear respects range and unknown positions', () => {
    expect(canHear(me, { x: 10, y: 64, z: 10 }, 15)).toBe(true);
    expect(canHear(me, { x: 16, y: 64, z: 0 }, 15)).toBe(false);
    expect(canHear(me, { x: 15, y: 64, z: 0 }, 15)).toBe(true);
    expect(canHear(me, undefined, 15)).toBe(false);
    expect(canHear(undefined, me, 15)).toBe(false);
  });

  it('say: heard only within 15 blocks with a known position; drops own; caps capacity', () => {
    const log = new ChatLog(2);
    expect(log.offer('Surv_01', 'Surv_01', 'me', me, me, ranges)).toBe(false);
    expect(log.offer('Surv_01', 'Far', 'hi', me, { x: 20, y: 64, z: 0 }, ranges)).toBe(false);
    expect(log.offer('Surv_01', 'Unknown', 'hi', me, undefined, ranges)).toBe(false);
    log.offer('Surv_01', 'A', 'one', me, { x: 1, y: 64, z: 0 }, ranges);
    log.offer('Surv_01', 'B', 'two', me, { x: 2, y: 64, z: 0 }, ranges);
    log.offer('Surv_01', 'C', 'three', me, { x: 3, y: 64, z: 0 }, ranges);
    expect(log.recent().map((h) => h.from)).toEqual(['B', 'C']);
    expect(log.takeUnread()).toBe(3);
    expect(log.takeUnread()).toBe(0);
  });

  it('shout: heard up to 1000 blocks, and from unknown (far human) positions', () => {
    const log = new ChatLog(10);
    expect(log.offer('Surv_01', 'Surv_02', `${SHOUT_PREFIX}village at 100 70 -200`, me, { x: 900, y: 64, z: 0 }, ranges)).toBe(true);
    expect(log.offer('Surv_01', 'Surv_03', `${SHOUT_PREFIX}too far`, me, { x: 1200, y: 64, z: 0 }, ranges)).toBe(false);
    expect(log.offer('Surv_01', 'Human', `${SHOUT_PREFIX}hello`, me, undefined, ranges)).toBe(true);
    const [first, second] = log.recent();
    expect(first).toMatchObject({ kind: 'shout', text: 'village at 100 70 -200', pos: { x: 900, y: 64, z: 0 } });
    expect(second).toMatchObject({ kind: 'shout', from: 'Human', pos: undefined });
    expect(formatHeard(first!, me)).toBe('<Surv_02 SHOUTS @900,64,0 (900m E)> village at 100 70 -200');
    expect(formatHeard(second!, me)).toBe('<Human SHOUTS (far away)> hello');
  });

  it('classifies and counts words', () => {
    expect(classifyChat('hi there')).toEqual({ kind: 'say', text: 'hi there' });
    expect(classifyChat(`${SHOUT_PREFIX} meet at spawn `)).toEqual({ kind: 'shout', text: 'meet at spawn' });
    expect(wordCount('  a b   c ')).toBe(3);
  });

  it('compass directions (-z is north)', () => {
    expect(compass(me, { x: 0, y: 64, z: -50 })).toBe('N');
    expect(compass(me, { x: 50, y: 64, z: 0 })).toBe('E');
    expect(compass(me, { x: -50, y: 64, z: 50 })).toBe('SW');
    expect(compass(me, me)).toBe('here');
  });

  it('roster forgets stale positions', () => {
    const r = new Roster();
    r.update('Surv_01', { x: 1, y: 2, z: 3 }, 1000);
    expect(r.get('Surv_01', 30_000, 2000)).toEqual({ x: 1, y: 2, z: 3 });
    expect(r.get('Surv_01', 30_000, 40_000)).toBeUndefined();
    expect(r.get('nobody')).toBeUndefined();
  });
});
