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
  /** The model's last few thoughts (why it chose what it did), newest last. */
  thoughts?: Array<{ text: string; at: number }>;
  /** A player's standing order, kept across restarts until it expires (epoch ms). */
  order?: { from: string; text: string; until: number };
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
  // Over the cap: drop the oldest entry of the most common kind (the 6th "water" goes before the only "bed").
  while (out.length > cap) {
    const counts = new Map<string, number>();
    for (const o of out) counts.set(o.what, (counts.get(o.what) ?? 0) + 1);
    const most = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    out.splice(out.findIndex((o) => o.what === most), 1);
  }
  return out;
}

const STOP = new Set(['the', 'a', 'an', 'to', 'and', 'or', 'for', 'of', 'in', 'on', 'is', 'are', 'be', 'it', 'with', 'conclusion', 'from', 'my', 'i', 'you', 'more', 'need', 'needed', 'essential', 'one', 'key', 'crucial', 'important', 'necessary', 'efficient', 'efficiently', 'before', 'first', 'then', 'enough', 'can', 'will', 'should', 'must', 'we', 'our', 'gather', 'gathering', 'gathers', 'making', 'make', 'survival', 'survive', 'use', 'using']);
/** Crude stemming so "splitting tasks"/"split task", "hunts"/"hunting", "logs"/"log" match. */
const stem = (w: string): string => w.replace(/(ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1');
const SYNONYM: Record<string, string> = { wood: 'log', plank: 'log', food: 'hunt', animal: 'hunt', mine: 'resourc', min: 'resourc', explor: 'resourc' };
const words = (t: string): Set<string> =>
  new Set(
    cleanLesson(t)
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map(stem)
      .map((w) => SYNONYM[w] ?? w),
  );

/** Strips list markers and (repeated) "Conclusion:" labels the model copies from its own prompt. PURE. */
export function cleanLesson(t: string): string {
  let s = t.trim();
  for (let i = 0; i < 4; i++) s = s.replace(/^\s*(?:[-*•]\s*|\[\d+\]\s*|conclusion\s*:\s*)/i, '');
  return s.trim();
}

/**
 * A model conclusion worth keeping as a lesson? Plans and to-dos ("Need to hunt a cow", "Follow X's
 * instructions", "Heading to ...") are not lessons: they filled the list and pushed real lessons out. PURE.
 */
export function isLessonWorthy(t: string): boolean {
  const s = cleanLesson(t);
  if (s.length < 12) return false;
  if (/^(i |we |you )?(still )?(need|needs|have|has|want|plan|going) (to|more)\b/i.test(s)) return false;
  if (/^(i|we|you) (should|must|will|am|are)\b/i.test(s)) return false;
  if (/^(follow|obey|listen|heading|going|let'?s|now|next|first|then|keep|continue)\b/i.test(s)) return false;
  return true;
}

/** Word-overlap similarity (Jaccard) of two lessons, 0..1. PURE. */
export function lessonSimilarity(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Adds a lesson unless an equivalent one exists (same start, or mostly the same words). Over the cap the
 * oldest model "Conclusion:" goes first; lessons from real failures, mentors and players stay longer. PURE.
 */
/** Max lessons kept per bot. */
export const LESSON_CAP = 15;

export function addLesson(list: string[], lesson: string, cap = LESSON_CAP): string[] {
  const l = lesson.trim().slice(0, 160);
  const key = cleanLesson(l).toLowerCase().slice(0, 50);
  if (!cleanLesson(l) || list.some((o) => cleanLesson(o).toLowerCase().slice(0, 50) === key || lessonSimilarity(o, l) >= 0.4)) return list;
  const out = [...list, l];
  while (out.length > cap) {
    const i = out.findIndex((o) => /^Conclusion:/.test(o));
    out.splice(i >= 0 && i < out.length - 1 ? i : 0, 1);
  }
  return out;
}

/** Cleans a stored lesson list: labels fixed, to-dos and near-duplicates removed (older files). PURE. */
export function tidyLessons(list: string[], cap = LESSON_CAP): string[] {
  let out: string[] = [];
  for (const raw of list) {
    const isConclusion = /^\s*(?:[-*•]\s*)?conclusion\s*:/i.test(raw);
    const body = cleanLesson(raw);
    if (isConclusion && !isLessonWorthy(body)) continue;
    if (!isConclusion && /unknown item|unknown block/i.test(raw)) continue;
    out = addLesson(out, isConclusion ? `Conclusion: ${body}` : raw.replace(/;\s*inventory [^;]*$/, ''), cap);
  }
  return out;
}

/** Turns a failed skill result into a reusable lesson, or undefined if it's not worth keeping. PURE. */
export function lessonFrom(skill: string, args: Record<string, unknown>, result: string): string | undefined {
  const r = result.trim().replace(/;\s*inventory [^;]*$/, ''); // the inventory change is not part of the lesson
  if (/unknown item|unknown block/i.test(r)) return undefined; // a typo, not a fact about the world
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
    if (this.data.lessons?.length) this.data.lessons = tidyLessons(this.data.lessons);
    if (this.data.order && this.data.order.until < Date.now()) delete this.data.order;
  }

  /** Model conclusion -> lesson, if it is a real lesson (not a to-do) and not a repeat. */
  conclude(text: string): boolean {
    if (!isLessonWorthy(text)) return false;
    return this.learn(`Conclusion: ${cleanLesson(text)}`);
  }

  /** The model asked to drop lesson [n] (1-based, as shown in its observation). Returns the dropped text. */
  forgetLesson(n: number): string | undefined {
    const list = this.data.lessons ?? [];
    if (n < 1 || n > list.length) return undefined;
    const [gone] = list.splice(n - 1, 1);
    this.save();
    return gone;
  }

  /** Keeps the last 3 distinct thoughts (shown to the model so it remembers what it was up to). */
  addThought(text: string): void {
    const t = text.trim().slice(0, 160);
    if (!t) return;
    const list = (this.data.thoughts ??= []);
    if (list.at(-1)?.text === t) list[list.length - 1]!.at = Date.now();
    else list.push({ text: t, at: Date.now() });
    if (list.length > 3) list.splice(0, list.length - 3);
    this.save();
  }

  setOrder(order: { from: string; text: string; until: number } | undefined): void {
    if (order) this.data.order = order;
    else delete this.data.order;
    this.save();
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
