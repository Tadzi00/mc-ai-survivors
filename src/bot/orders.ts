/**
 * Player orders (PURE, unit-tested). A private message from a human is either a direct command that the
 * code executes immediately (no model: "build shelter", "stop", "come here") or, if it reads like an
 * instruction, a standing order shown at the top of the observation for a few minutes. Small models kept
 * agreeing ("I'll build a shelter now") and then drifting back to their own plan.
 */
import type { PlannedAction } from './action.js';

export interface DirectCommand {
  /** Steps to run right away, replacing the current plan. */
  steps: PlannedAction[];
  /** Short reply to whisper back. */
  ack: string;
}

const step = (skill: PlannedAction['skill'], args: Record<string, unknown>, thought: string): PlannedAction => ({ skill, args, thought });

export function parseDirectCommand(text: string, from: string): DirectCommand | undefined {
  const t = text.toLowerCase().trim();
  const why = `order from ${from}`;
  if (/^(stop|wait|stay|hold on|freeze)\b/.test(t)) {
    return { steps: [step('wait', { seconds: 30 }, why)], ack: 'Stopping. Waiting here for 30s.' };
  }
  if (/\b(come|follow)\b.*\b(here|me)\b|\bcome to me\b/.test(t)) {
    return { steps: [step('follow', { player: from, seconds: 60 }, why)], ack: `Coming to you, ${from}.` };
  }
  if (/\bbuild\b.*\b(shelter|house|home|hut|base)\b/.test(t)) {
    // "... with two beds and a torch": the extras become steps too (the model used to drop them).
    const beds = Math.min(4, countBefore(t, /beds?\b/) ?? (/\bbeds?\b/.test(t) ? 1 : 0));
    const steps = [step('build_shelter', { size: 5 }, why), step('place_torch', {}, why)];
    for (let i = 0; i < beds; i++) steps.push(step('place_bed', {}, why));
    return { steps, ack: `Building a shelter now${beds ? ` with ${beds} bed${beds > 1 ? 's' : ''}` : ''}.` };
  }
  const crafts = /\b(make|craft)\b/.test(t) ? craftTargets(t) : [];
  if (crafts.length) {
    return { steps: crafts.map((c) => step('craft', { item: c.item, count: c.count }, why)), ack: `Crafting ${crafts.map((c) => c.item).join(', ')}.` };
  }
  if (/\bsmelt\b/.test(t) && /\b(iron|gold|copper)\b/.test(t)) {
    const metal = /\bgold\b/.test(t) ? 'gold' : /\bcopper\b/.test(t) ? 'copper' : 'iron';
    const steps: PlannedAction[] = [];
    if (/\bchest\b/.test(t)) steps.push(step('chest_take', { items: [`raw_${metal}`, 'coal'] }, why));
    steps.push(step('smelt', { item: `raw_${metal}`, count: 64 }, why));
    return { steps, ack: `Smelting the ${metal}.` };
  }
  if (/\b(go|get|run)\b.*\bhome\b/.test(t)) {
    return { steps: [step('goto', { place: 'home' }, why)], ack: 'Going home.' };
  }
  if (/^(go to )?sleep\b|\bgo to bed\b/.test(t)) {
    return { steps: [step('sleep', {}, why)], ack: 'Going to sleep.' };
  }
  if (/^eat\b|\beat (something|now|food)\b/.test(t)) {
    return { steps: [step('eat', {}, why)], ack: 'Eating.' };
  }
  return undefined;
}

const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, some: 2, few: 3 };

/** The number written right before a word ("two beds", "3 torches"). PURE. */
export function countBefore(t: string, word: RegExp): number | undefined {
  const m = new RegExp(`\\b(\\d+|${Object.keys(NUMBERS).join('|')})\\s+(?:\\w+\\s+)?${word.source}`).exec(t);
  if (!m) return undefined;
  return /^\d+$/.test(m[1]!) ? Number(m[1]) : NUMBERS[m[1]!];
}

const TOOL_RE = /\b(wooden|wood|stone|iron|golden|gold|diamond)\s+(pickaxe|sword|axe|shovel|hoe)s?\b/g;
const OTHER_ITEMS: Array<[RegExp, string]> = [
  [/\bcrafting tables?\b/, 'crafting_table'],
  [/\bfurnaces?\b/, 'furnace'],
  [/\bchests?\b/, 'chest'],
  [/\btorch(es)?\b/, 'torch'],
  [/\bbeds?\b/, 'bed'],
  [/\bdoors?\b/, 'door'],
  [/\bsticks?\b/, 'stick'],
  [/\bplanks?\b/, 'planks'],
  [/\bbook and quill\b|\bwritable book\b/, 'writable_book'],
];

/** Items named in "make a stone pickaxe, a stone sword and 4 torches". PURE. */
export function craftTargets(t: string): Array<{ item: string; count: number }> {
  const out: Array<{ item: string; count: number; at: number }> = [];
  for (const m of t.matchAll(TOOL_RE)) {
    const mat = m[1] === 'wood' ? 'wooden' : m[1] === 'gold' ? 'golden' : m[1]!;
    const item = `${mat}_${m[2]}`;
    if (!out.some((o) => o.item === item)) out.push({ item, count: 1, at: m.index ?? 0 });
  }
  const rest = t.replace(TOOL_RE, (x) => ' '.repeat(x.length)); // keep positions
  for (const [re, item] of OTHER_ITEMS) {
    const m = re.exec(rest);
    if (m) out.push({ item, count: Math.min(16, countBefore(rest, re) ?? 1), at: m.index });
  }
  return out.sort((a, b) => a.at - b.at).map(({ item, count }) => ({ item, count }));
}

/** Does this message read like an instruction (vs. a question or small talk)? */
export function looksLikeOrder(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (/\?\s*$/.test(t)) return false;
  return /^(please |pls |now |ok |okay )?(go|get|gather|mine|chop|collect|craft|make|build|place|put|bring|give|hunt|kill|attack|find|explore|dig|take|store|plant|farm|light|stay|follow|help|use|open|close|don't|do not|never|always|wear|equip|write|read|remember|note|sign)\b/.test(
    t,
  );
}
