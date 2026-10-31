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

  setGoal(goal: string | null): void {
    this.data.goal = goal;
    this.save();
  }

  save(): void {
    writeJsonFile(this.file, this.data);
  }
}
