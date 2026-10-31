/**
 * Proximity chat (INTENTIONAL, see DESIGN.md §6.1):
 *  - "say": heard only within `chatRange` blocks (default 15) and only if the speaker's position is known.
 *  - "shout": a message starting with SHOUT_PREFIX, heard within `shoutRange` blocks (default 1000).
 *    Bot positions come from the shared roster, so far-away bots are located even outside entity range;
 *    a far-away human (unknown position) is assumed to be within shout range.
 */
export interface Pos {
  x: number;
  y: number;
  z: number;
}

export const SHOUT_PREFIX = '[SHOUT] ';

export type ChatKind = 'say' | 'shout';

export function distance(a: Pos, b: Pos): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function canHear(listener: Pos | undefined, speaker: Pos | undefined, range: number): boolean {
  if (!listener || !speaker) return false;
  return distance(listener, speaker) <= range;
}

/** Splits a raw chat line into kind + text. */
export function classifyChat(message: string): { kind: ChatKind; text: string } {
  if (message.startsWith(SHOUT_PREFIX)) return { kind: 'shout', text: message.slice(SHOUT_PREFIX.length).trim() };
  return { kind: 'say', text: message };
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Compass direction from `from` to `to` (Minecraft: -z is north, +x is east). */
export function compass(from: Pos, to: Pos): string {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.hypot(dx, dz) < 1) return 'here';
  const deg = (Math.atan2(dx, -dz) * 180) / Math.PI; // 0 = north, 90 = east
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[(Math.round(((deg + 360) % 360) / 45) % 8)]!;
}

export interface HeardMessage {
  from: string;
  text: string;
  at: number;
  kind: ChatKind;
  /** Distance when known. */
  distance?: number;
  /** Speaker position when known (shouts show it so bots can meet up). */
  pos?: Pos;
}

export interface Ranges {
  say: number;
  shout: number;
}

/** Ring buffer of recently heard messages. */
export class ChatLog {
  private readonly items: HeardMessage[] = [];
  private unread = 0;

  constructor(private readonly capacity: number) {}

  /** Returns true if the message was heard (and stored). */
  offer(self: string, from: string, raw: string, listener: Pos | undefined, speaker: Pos | undefined, ranges: Ranges, now = Date.now()): boolean {
    if (from === self) return false;
    const { kind, text } = classifyChat(raw);
    if (!text) return false;
    if (kind === 'say') {
      if (!canHear(listener, speaker, ranges.say)) return false;
    } else if (listener && speaker && distance(listener, speaker) > ranges.shout) {
      return false;
    }
    const d = listener && speaker ? distance(listener, speaker) : undefined;
    this.items.push({
      from,
      text: text.slice(0, 240),
      at: now,
      kind,
      distance: d,
      pos: speaker ? { x: Math.floor(speaker.x), y: Math.floor(speaker.y), z: Math.floor(speaker.z) } : undefined,
    });
    while (this.items.length > this.capacity) this.items.shift();
    this.unread++;
    return true;
  }

  recent(): readonly HeardMessage[] {
    return this.items;
  }

  /** Number of messages since last call (used to wake the planner). */
  takeUnread(): number {
    const n = this.unread;
    this.unread = 0;
    return n;
  }
}

/** One line per heard message for the observation. */
export function formatHeard(h: HeardMessage, me: Pos | undefined): string {
  const where =
    h.pos && me ? ` @${h.pos.x},${h.pos.y},${h.pos.z} (${Math.round(h.distance ?? distance(me, h.pos))}m ${compass(me, h.pos)})` : h.distance !== undefined ? ` ${Math.round(h.distance)}m` : ' (far away)';
  return `<${h.from}${h.kind === 'shout' ? ' SHOUTS' : ''}${where}> ${h.text}`;
}

/** Positions of all bots run by this orchestrator (shared by agents; used to place far-away shouters). */
export class Roster {
  private readonly pos = new Map<string, Pos & { t: number }>();

  update(name: string, p: Pos, now = Date.now()): void {
    this.pos.set(name, { x: p.x, y: p.y, z: p.z, t: now });
  }

  remove(name: string): void {
    this.pos.delete(name);
  }

  /** Last known position if updated within `maxAgeMs`. */
  get(name: string, maxAgeMs = 30_000, now = Date.now()): Pos | undefined {
    const p = this.pos.get(name);
    return p && now - p.t <= maxAgeMs ? { x: p.x, y: p.y, z: p.z } : undefined;
  }
}
