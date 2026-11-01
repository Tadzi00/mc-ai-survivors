// Knowledge flow between bots (PURE, unit-tested): what to teach, what to share when meeting, which "say"
// is useless chatter, questions and answers, newborn names. The agent does the talking and walking.
import { isGarbageLesson, type Discovery, type MemoryData, type Place } from './memory.js';

// ---------------------------------------------------------------- lessons

/**
 * The most valuable lessons first: things a player taught > lessons from real failures > the model's own
 * conclusions; deaths and "X is my mentor" are not teachable.
 */
export function topLessons(lessons: readonly string[], n: number): string[] {
  const score = (l: string): number => {
    if (/^Taught by /.test(l)) return 4;
    if (/^(From \w+: )?Taught by /.test(l)) return 4;
    if (/^Conclusion:/.test(l) || /^From \w+: Conclusion:/.test(l)) return 1;
    if (/^At night|^gather |^craft |^smelt |^build_shelter|^attack /.test(l.replace(/^From \w+: /, ''))) return 3;
    return 2;
  };
  return lessons
    .filter((l) => !/^DEATH|is my mentor|gave me a home|My home is/.test(l) && !isGarbageLesson(l))
    .map((l, i) => ({ l, s: score(l), i }))
    .sort((a, b) => b.s - a.s || b.i - a.i)
    .slice(0, n)
    .map((x) => x.l.replace(/^From \w+: /, '').replace(/^Taught by \w+: /, ''));
}

// ---------------------------------------------------------------- sharing

export interface ShareItem {
  kind: 'place' | 'discovery' | 'lesson' | 'chest';
  /** Spoken sentence. */
  text: string;
  place?: { key: string; p: Place };
  discovery?: Discovery;
  lesson?: string;
}

/** Valuable finds worth telling others about (in this order). */
const FIND_VALUE: Array<[RegExp, number]> = [
  [/diamond/, 10], [/iron_ore/, 8], [/gold_ore/, 6], [/coal_ore/, 6], [/cows|sheeps|pigs|chickens/, 5],
  [/trees/, 4], [/copper/, 3], [/water|sugar_cane|clay|sand/, 2], [/danger/, 7],
];
const findValue = (what: string): number => FIND_VALUE.find(([re]) => re.test(what))?.[1] ?? 1;

/**
 * What `teacher` knows that `learner` doesn't (max `max` items, most useful first): the village, shared
 * utilities, valuable finds the learner has none of within 48 blocks, and lessons it lacks.
 */
export function whatToShare(teacher: MemoryData, learner: MemoryData, max = 3, lessonSimilar: (a: string, b: string) => boolean = () => false): ShareItem[] {
  const out: ShareItem[] = [];
  const tv = teacher.places.village, lv = learner.places.village;
  if (tv && (!lv || Math.hypot(tv.x - lv.x, tv.z - lv.z) > 8)) {
    out.push({ kind: 'place', text: `our village is at ${tv.x} ${tv.y} ${tv.z}`, place: { key: 'village', p: tv } });
  }
  const finds = (teacher.discoveries ?? [])
    .filter((d) => !/^spot shouted/.test(d.what))
    .filter((d) => !(learner.discoveries ?? []).some((o) => o.what === d.what && Math.hypot(o.x - d.x, o.z - d.z) <= 48))
    .sort((a, b) => findValue(b.what) - findValue(a.what));
  for (const d of finds.slice(0, 2)) {
    out.push({ kind: 'discovery', text: `${d.what.replace(/_/g, ' ')} at ${d.x} ${d.y} ${d.z}`, discovery: d });
  }
  const mine = learner.lessons ?? [];
  for (const l of topLessons(teacher.lessons ?? [], 6)) {
    if (mine.some((m) => m.includes(l) || lessonSimilar(m, l))) continue;
    out.push({ kind: 'lesson', text: l, lesson: l });
    break; // one lesson per meeting is plenty
  }
  return out.slice(0, max);
}

// ---------------------------------------------------------------- chatter

/** "Heading to gather 8 logs", "Exploring for cows" - narration that tells nobody anything. */
export function isChatter(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (/-?\d+[ ,]+-?\d+[ ,]+-?\d+/.test(t)) return false; // coordinates are information
  if (/\?$/.test(t)) return false; // questions are fine
  if (/\b(found|learned|careful|danger|warning|died|zombie|creeper|skeleton|winter|help|village|iron|diamond|coal)\b/.test(t)) return false;
  return /^(i'?m |i will |i'll |let'?s |now |ok,? |okay,? |going |heading|gathering|exploring|crafting|building|placing|looking|getting|moving|working|resuming|starting|following|continuing|trying|need|gonna)/.test(t);
}

const wordsOf = (t: string): Set<string> => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Close to something said in the last minutes (word overlap)? */
export function saidRecently(text: string, recent: ReadonlyArray<{ text: string; at: number }>, now = Date.now(), windowMs = 300_000): boolean {
  const a = wordsOf(text);
  if (!a.size) return true;
  return recent.some((r) => {
    if (now - r.at > windowMs) return false;
    const b = wordsOf(r.text);
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / (a.size + b.size - inter) >= 0.5;
  });
}

// ---------------------------------------------------------------- questions

const ASK_TARGETS: Array<[RegExp, string[]]> = [
  [/\bcows?\b/, ['cows']], [/\bsheep\b/, ['sheeps']], [/\bpigs?\b/, ['pigs']], [/\bchickens?\b/, ['chickens']],
  [/\b(food|animals?|meat)\b/, ['cows', 'pigs', 'sheeps', 'chickens']], [/\bwool\b/, ['sheeps']],
  [/\biron\b/, ['iron_ore']], [/\bcoal\b/, ['coal_ore']], [/\bdiamonds?\b/, ['diamond_ore']], [/\bgold\b/, ['gold_ore']],
  [/\bcopper\b/, ['copper_ore']], [/\b(trees?|wood|logs?)\b/, ['trees']], [/\bwater\b/, ['water']],
  [/\bsugar ?cane|paper\b/, ['sugar_cane']], [/\bsand\b/, ['sand']], [/\bclay\b/, ['clay']], [/\bvillage\b/, ['village']],
];

/** "Anyone know where cows are?" -> ['cows']; not a where-question -> []. */
export function askedFor(text: string): string[] {
  const t = text.toLowerCase();
  if (!/\?|anyone know|any(one|body) seen|where (is|are|can)|need .* (where|location)/.test(t)) return [];
  if (!/where|know|seen|find|location/.test(t)) return [];
  for (const [re, kinds] of ASK_TARGETS) if (re.test(t)) return kinds;
  return [];
}

/** The nearest known spot of one of `kinds` (to the asker if their position is known). */
export function answerFrom(kinds: string[], data: MemoryData, near?: { x: number; z: number }): string | undefined {
  if (kinds.includes('village') && data.places.village) {
    const v = data.places.village;
    return `village at ${v.x} ${v.y} ${v.z}`;
  }
  const hits = (data.discoveries ?? []).filter((d) => kinds.includes(d.what));
  if (!hits.length) return undefined;
  const ref = near ?? hits[0]!;
  hits.sort((a, b) => Math.hypot(a.x - ref.x, a.z - ref.z) - Math.hypot(b.x - ref.x, b.z - ref.z));
  const d = hits[0]!;
  return `${d.what.replace(/_/g, ' ')} at ${d.x} ${d.y} ${d.z}`;
}

/** "iron ore at 120 40 -5" in news/answers -> a discovery kind for the listener. */
export function kindFromNews(text: string): string | undefined {
  const t = text.toLowerCase();
  for (const [re, kinds] of ASK_TARGETS) if (re.test(t) && kinds[0] !== 'village') return kinds[0];
  return undefined;
}

// ---------------------------------------------------------------- names

/**
 * A newborn's name from the model's reply: letters only, 3-10 chars, capitalised, prefixed; must not match
 * any bot that ever lived (also ignoring the prefix and case). Undefined when unusable.
 */
export function cleanBotName(reply: string, prefix: string, used: ReadonlySet<string>): string | undefined {
  const m = /"name"\s*:\s*"([^"]+)"/.exec(reply) ?? /^\s*([A-Za-z][A-Za-z]{2,})/.exec(reply.replace(new RegExp(`^${prefix}`, 'i'), ''));
  if (!m) return undefined;
  let core = m[1]!.replace(new RegExp(`^${prefix}`, 'i'), '').replace(/[^A-Za-z]/g, '');
  if (core.length < 3) return undefined;
  core = core.slice(0, Math.max(3, Math.min(10, 16 - prefix.length)));
  core = core[0]!.toUpperCase() + core.slice(1).toLowerCase();
  const lower = new Set([...used].map((u) => u.toLowerCase()));
  const free = (c: string): boolean => !lower.has(`${prefix}${c}`.toLowerCase()) && !lower.has(c.toLowerCase());
  if (free(core)) return `${prefix}${core}`;
  // Taken (the model likes to repeat itself): a close variant - last vowel changed, or a letter added.
  const max = Math.max(3, Math.min(10, 16 - prefix.length));
  const vowels = ['a', 'e', 'i', 'o', 'u'];
  const lastV = [...core].map((ch, i) => ({ ch, i })).filter((x) => vowels.includes(x.ch.toLowerCase())).pop();
  const variants: string[] = [];
  if (lastV) for (const v of vowels) variants.push(core.slice(0, lastV.i) + v + core.slice(lastV.i + 1));
  for (const end of ['a', 'o', 'n', 'el', 'ia']) variants.push((core + end).slice(0, max));
  const pick = variants.find((v) => v !== core && free(v));
  return pick ? `${prefix}${pick}` : undefined;
}
