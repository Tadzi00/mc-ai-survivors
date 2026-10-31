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

/** Adds a lesson unless an equivalent one (same first 50 chars, case-insensitive) exists. PURE. */
export function addLesson(list: string[], lesson: string, cap = 15): string[] {
  const l = lesson.trim().slice(0, 160);
  const key = l.toLowerCase().slice(0, 50);
  if (!l || list.some((o) => o.toLowerCase().slice(0, 50) === key)) return list;
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

  setGoal(goal: string | null): void {
    this.data.goal = goal;
    this.save();
  }

  save(): void {
    writeJsonFile(this.file, this.data);
  }
}
