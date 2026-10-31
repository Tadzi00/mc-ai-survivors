import { describe, expect, it } from 'vitest';
import { canHear, ChatLog } from '../src/bot/chat.js';

describe('proximity chat', () => {
  const me = { x: 0, y: 64, z: 0 };
  it('hears only within range', () => {
    expect(canHear(me, { x: 10, y: 64, z: 10 }, 32)).toBe(true);
    expect(canHear(me, { x: 40, y: 64, z: 0 }, 32)).toBe(false);
    expect(canHear(me, { x: 32, y: 64, z: 0 }, 32)).toBe(true);
  });
  it('ignores unknown positions', () => {
    expect(canHear(me, undefined, 32)).toBe(false);
    expect(canHear(undefined, me, 32)).toBe(false);
  });
  it('ChatLog stores heard messages, drops own and far ones, caps capacity', () => {
    const log = new ChatLog(2);
    expect(log.offer('Surv_01', 'Surv_01', 'me', me, me, 32)).toBe(false);
    expect(log.offer('Surv_01', 'Far', 'hi', me, { x: 100, y: 64, z: 0 }, 32)).toBe(false);
    expect(log.offer('Surv_01', 'Unknown', 'hi', me, undefined, 32)).toBe(false);
    log.offer('Surv_01', 'A', 'one', me, { x: 1, y: 64, z: 0 }, 32);
    log.offer('Surv_01', 'B', 'two', me, { x: 2, y: 64, z: 0 }, 32);
    log.offer('Surv_01', 'C', 'three', me, { x: 3, y: 64, z: 0 }, 32);
    expect(log.recent().map((m) => m.from)).toEqual(['B', 'C']);
    expect(log.takeUnread()).toBe(3);
    expect(log.takeUnread()).toBe(0);
  });
});
