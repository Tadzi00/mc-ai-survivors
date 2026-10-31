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
    return { steps: [step('build_shelter', { size: 5 }, why), step('place_torch', {}, why)], ack: 'Building a shelter now.' };
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

/** Does this message read like an instruction (vs. a question or small talk)? */
export function looksLikeOrder(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (/\?\s*$/.test(t)) return false;
  return /^(please |pls |now |ok |okay )?(go|get|gather|mine|chop|collect|craft|make|build|place|put|bring|give|hunt|kill|attack|find|explore|dig|take|store|plant|farm|light|stay|follow|help|use|open|close|don't|do not|never|always|wear|equip)\b/.test(
    t,
  );
}
