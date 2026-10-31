/**
 * Proximity chat (INTENTIONAL, see DESIGN.md): a bot only hears messages from players whose
 * entity position is known and within `range` blocks. Unknown position => not heard.
 */
export interface Pos {
  x: number;
  y: number;
  z: number;
}

export function distance(a: Pos, b: Pos): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function canHear(listener: Pos | undefined, speaker: Pos | undefined, range: number): boolean {
  if (!listener || !speaker) return false;
  return distance(listener, speaker) <= range;
}

export interface HeardMessage {
  from: string;
  text: string;
  at: number;
  distance: number;
}

/** Ring buffer of recently heard messages. */
export class ChatLog {
  private readonly items: HeardMessage[] = [];
  private unread = 0;

  constructor(private readonly capacity: number) {}

  /** Returns true if the message was heard (and stored). */
  offer(self: string, from: string, text: string, listener: Pos | undefined, speaker: Pos | undefined, range: number, now = Date.now()): boolean {
    if (from === self) return false;
    if (!canHear(listener, speaker, range)) return false;
    this.items.push({ from, text: text.slice(0, 240), at: now, distance: distance(listener!, speaker!) });
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
