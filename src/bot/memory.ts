import path from 'node:path';
import { readJsonFile, writeJsonFile } from '../util/fsjson.js';

export interface Place {
  x: number;
  y: number;
  z: number;
  note?: string;
}

export interface MemoryData {
  name: string;
  goal: string | null;
  notes: string[];
  places: Record<string, Place>;
  /** Auto-recorded finds: ores, water, animals, dangers, shouted spots. */
  discoveries?: Discovery[];
  /** Auto-recorded lessons from failures and events ("need a stone pickaxe for iron_ore"). */
  lessons?: string[];
  /** Known chests: "x,y,z" -> contents as last seen or heard about. */
  storage?: Record<string, Chest>;
  /** Outlines of shelters/rooms this bot built (outer walls), for extend_shelter. */
  shelters?: Array<{ x0: number; z0: number; x1: number; z1: number; y0: number }>;
}

export interface Chest {
  x: number;
  y: number;
  z: number;
  items: Record<string, number>;
  /** ISO time of the last update. */
  at: string;
  /** Who the information came from ("me" or a bot/player name). */
  by: string;
}

export const chestKey = (p: { x: number; y: number; z: number }): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

/** Applies a stored (+) / took (-) report to known contents; never below zero. PURE. */
export function applyChestDelta(items: Record<string, number>, delta: Record<string, number>, sign: 1 | -1): Record<string, number> {
  const out = { ...items };
  for (const [k, v] of Object.entries(delta)) {
    const n = (out[k] ?? 0) + sign * v;
    if (n > 0) out[k] = n;
    else delete out[k];
  }
  return out;
}

/** Parses "Stored 15 cobblestone, 5 bread in the chest at -11 99 -11" / "Took 5 cobblestone from the chest at x y z". PURE. */
export function parseChestReport(text: string): { sign: 1 | -1; items: Record<string, number>; pos: { x: number; y: number; z: number } } | undefined {
  const m = /^(stored|took)\s+(.+?)\s+(?:in|from) the chest at (-?\d+) (-?\d+) (-?\d+)/i.exec(text.trim());
  if (!m) return undefined;
  const items: Record<string, number> = {};
  for (const it of m[2]!.matchAll(/(\d+) ([a-z0-9_]+)/g)) items[it[2]!] = (items[it[2]!] ?? 0) + Number(it[1]);
  if (Object.keys(items).length === 0) return undefined;
  return { sign: m[1]!.toLowerCase() === 'stored' ? 1 : -1, items, pos: { x: Number(m[3]), y: Number(m[4]), z: Number(m[5]) } };
}

export interface Discovery {
  what: string;
  x: number;
  y: number;
  z: number;
  at: string;
}

/**
 * Adds a discovery unless the same kind is already known within `mergeDist` blocks (keeps the list
 * meaningful: "iron here", not every single ore block). Oldest entries drop out past `cap`. PURE.
 */
export function addDiscovery(list: Discovery[], d: Discovery, mergeDist = 24, cap = 40): Discovery[] {
  if (list.some((o) => o.what === d.what && Math.hypot(o.x - d.x, o.y - d.y, o.z - d.z) <= mergeDist)) return list;
  const out = [...list, d];
  return out.length > cap ? out.slice(out.length - cap) : out;
}

const STOP = new Set(['the', 'a', 'an', 'to', 'and', 'or', 'for', 'of', 'in', 'on', 'is', 'are', 'be', 'it', 'with', 'conclusion', 'from', 'my', 'i', 'you', 'more', 'need', 'needed', 'essential']);
const words = (t: string): Set<string> =>
  new Set(t.toLowerCase().replace(/^conclusion:\s*/, '').split(/[^a-z0-9_]+/).filter((w) => w.length > 2 && !STOP.has(w)));

/** Word-overlap similarity (Jaccard) of two lessons, 0..1. PURE. */
export function lessonSimilarity(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Adds a lesson unless an equivalent one exists (same start, or mostly the same words). PURE. */
export function addLesson(list: string[], lesson: string, cap = 15): string[] {
  const l = lesson.trim().slice(0, 160);
  const key = l.toLowerCase().slice(0, 50);
  if (!l || list.some((o) => o.toLowerCase().slice(0, 50) === key || lessonSimilarity(o, l) >= 0.5)) return list;
  const out = [...list, l];
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** Turns a failed skill result into a reusable lesson, or undefined if it's not worth keeping. PURE. */
export function lessonFrom(skill: string, args: Record<string, unknown>, result: string): string | undefined {
  const r = result.trim();
  if (!/^(cannot|could not|need|not enough|too |no known recipe|unknown item|you already)/i.test(r)) return undefined;
  if (/within \d+ blocks|cooldown|interrupted|timed out|try again/i.test(r)) return undefined; // situational
  const what = typeof args.item === 'string' ? args.item : typeof args.block === 'string' ? args.block : '';
  return `${skill}${what ? ` ${what}` : ''}: ${r}`;
}

/**
 * Deterministic note compaction (no LLM call): when over `max`, the oldest half is merged into a
 * single "Older notes:" line (deduplicated, truncated). Keeps memory bounded for small models.
 */
export function compactNotes(notes: string[], max: number): string[] {
  if (notes.length <= max) return notes;
  const half = Math.ceil(notes.length / 2);
  const old = notes.slice(0, half);
  const pieces: string[] = [];
  for (const n of old) {
    const t = n.replace(/^Older notes: /, '').trim();
    for (const p of t.split(' | ')) if (p && !pieces.includes(p)) pieces.push(p);
  }
  let merged = 'Older notes: ' + pieces.join(' | ');
  if (merged.length > 600) merged = merged.slice(0, 597) + '...';
  return [merged, ...notes.slice(half)];
}

/** Per-bot persistent memory in state/bots/<name>.json. */
export class Memory {
  data: MemoryData;
  private readonly file: string;

  constructor(stateDir: string, name: string, private readonly maxNotes: number) {
    this.file = path.join(stateDir, 'bots', `${name}.json`);
    this.data = readJsonFile<MemoryData>(this.file) ?? { name, goal: null, notes: [], places: {} };
  }

  addNote(note: string): void {
    const n = note.trim().slice(0, 200);
    if (!n || this.data.notes.at(-1) === n) return;
    this.data.notes.push(n);
    this.data.notes = compactNotes(this.data.notes, this.maxNotes);
    this.save();
  }

  setPlace(name: string, p: Place): void {
    this.data.places[name.toLowerCase()] = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), note: p.note };
    this.save();
  }

  place(name: string): Place | undefined {
    return this.data.places[name.toLowerCase()];
  }

  discover(what: string, p: { x: number; y: number; z: number }): boolean {
    const before = this.data.discoveries ?? [];
    const after = addDiscovery(before, { what, x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), at: new Date().toISOString() });
    if (after === before) return false;
    this.data.discoveries = after;
    this.save();
    return true;
  }

  learn(lesson: string): boolean {
    const before = this.data.lessons ?? [];
    const after = addLesson(before, lesson);
    if (after === before) return false;
    this.data.lessons = after;
    this.save();
    return true;
  }

  /** Exact contents seen by opening the chest. */
  setChest(p: { x: number; y: number; z: number }, items: Record<string, number>, by: string): void {
    const st = (this.data.storage ??= {});
    st[chestKey(p)] = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), items, at: new Date().toISOString(), by };
    this.save();
  }

  /** Someone said they stored/took items: adjust what we believe is inside. */
  adjustChest(p: { x: number; y: number; z: number }, delta: Record<string, number>, sign: 1 | -1, by: string): void {
    const st = (this.data.storage ??= {});
    const prev = st[chestKey(p)];
    st[chestKey(p)] = {
      x: Math.floor(p.x),
      y: Math.floor(p.y),
      z: Math.floor(p.z),
      items: applyChestDelta(prev?.items ?? {}, delta, sign),
      at: new Date().toISOString(),
      by,
    };
    this.save();
  }

  setGoal(goal: string | null): void {
    this.data.goal = goal;
    this.save();
  }

  save(): void {
    writeJsonFile(this.file, this.data);
  }
}
