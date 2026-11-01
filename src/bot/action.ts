/** Parsing + validation of the planner's single JSON action. PURE (unit-tested). */
import { z } from 'zod';
import type { Tier } from '../lifecycle/policy.js';
import { isSkillName, SkillArgs, skillsForTier, type SkillName } from '../skills/schemas.js';
import { extractJsonObject } from '../util/json.js';

export interface PlannedAction {
  thought: string;
  skill: SkillName;
  args: Record<string, unknown>;
}

export type ParseResult = { ok: true; action: PlannedAction } | { ok: false; error: string };

const Envelope = z.object({
  thought: z.string().optional().default(''),
  skill: z.string(),
  args: z.record(z.string(), z.unknown()).optional().default({}),
});

/** Accepts {"thought","skill","args"}; tolerates "action" for "skill" and args inlined at top level. */
export function parseAction(text: string, tier: Tier): ParseResult {
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'no JSON object found' };
  const o = { ...(obj as Record<string, unknown>) };
  if (o.skill === undefined && typeof o.action === 'string') o.skill = o.action;
  if (o.args === undefined) {
    const { thought: _t, skill: _s, action: _a, say: _say, learned: _l, forget: _f, ...rest } = o;
    o.args = rest;
  }
  const env = Envelope.safeParse(o);
  if (!env.success) return { ok: false, error: `bad envelope: ${env.error.issues.map((i) => i.message).join('; ')}` };
  const skill = env.data.skill.trim().toLowerCase();
  if (!isSkillName(skill)) return { ok: false, error: `unknown skill "${skill}"` };
  if (!skillsForTier(tier).includes(skill)) return { ok: false, error: `skill "${skill}" not available to ${tier} bots` };
  const args = SkillArgs[skill].safeParse(env.data.args);
  if (!args.success) {
    return {
      ok: false,
      error: `invalid args for ${skill}: ${args.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}`,
    };
  }
  return {
    ok: true,
    action: { thought: env.data.thought.slice(0, 300), skill, args: args.data as Record<string, unknown> },
  };
}

export const MAX_PLAN_STEPS = 5;

export type PlanResult =
  | { ok: true; thought: string; steps: PlannedAction[]; say?: string; learned?: string; forget?: number }
  | { ok: false; error: string };

/** Optional conclusion the bot drew ("cows don't live in caves"); stored as a lasting lesson. */
function learnedOf(o: Record<string, unknown>): string | undefined {
  if (typeof o.learned !== 'string') return undefined;
  const t = o.learned.trim().slice(0, 160);
  return t.length >= 8 ? t : undefined;
}

/** Optional lesson number to drop ("forget": 3 or "[3]"): a wrong/useless lesson, or room for a new one. */
function forgetOf(o: Record<string, unknown>): number | undefined {
  const n = typeof o.forget === 'number' ? o.forget : typeof o.forget === 'string' ? Number(/\d+/.exec(o.forget)?.[0]) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** Optional free speech that comes with any reply: {"say":"..."}; spoken to nearby players, costs no turn. */
function sayOf(o: Record<string, unknown>): string | undefined {
  if (typeof o.say !== 'string') return undefined;
  const t = o.say.replace(/^[/\s]+/, '').replace(/^\[SHOUT\]\s*/i, '').trim().slice(0, 200);
  return t || undefined;
}

/**
 * Smart bots may answer with a short plan: {"thought","plan":[{"skill","args"},...]} (max 5 steps).
 * A single {"thought","skill","args"} is accepted as a one-step plan (and is the only form for basic bots:
 * a basic bot's plan is cut to its first step). Every step is validated; one bad step rejects the plan so
 * the model can fix it.
 */
export function parsePlan(text: string, tier: Tier): PlanResult {
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'no JSON object found' };
  const o = obj as Record<string, unknown>;
  const rawSteps = Array.isArray(o.plan) ? o.plan : Array.isArray(o.steps) ? o.steps : undefined;
  if (!rawSteps) {
    const single = parseAction(text, tier);
    return single.ok ? { ok: true, thought: single.action.thought, steps: [single.action], say: sayOf(o), learned: learnedOf(o), forget: forgetOf(o) } : single;
  }
  if (rawSteps.length === 0) return { ok: false, error: 'plan is empty' };
  const thought = typeof o.thought === 'string' ? o.thought.slice(0, 300) : '';
  const limit = tier === 'smart' ? MAX_PLAN_STEPS : 1;
  const steps: PlannedAction[] = [];
  for (const [i, step] of rawSteps.slice(0, limit).entries()) {
    const r = parseAction(JSON.stringify(step), tier);
    if (!r.ok) return { ok: false, error: `plan step ${i + 1}: ${r.error}` };
    steps.push({ ...r.action, thought: r.action.thought || thought });
  }
  return { ok: true, thought, steps, say: sayOf(o), learned: learnedOf(o), forget: forgetOf(o) };
}

/** Heuristic: did a skill result string report failure? Used to abandon the rest of a plan. */
export function looksFailed(result: string): boolean {
  return /^(failed|cannot|could not|couldn't|no |not enough|need |unknown|timed out|interrupted|found no|too |you already|shout on cooldown|target .* inside)/i.test(
    result.trim(),
  );
}

/** Deterministic fallback when the model fails twice: get wood if poor, otherwise explore. */
export function fallbackAction(logCount: number): PlannedAction {
  if (logCount < 8) return { thought: '(fallback) gather wood', skill: 'gather', args: { block: 'log', count: 4 } };
  return { thought: '(fallback) explore', skill: 'explore', args: { distance: 40 } };
}
