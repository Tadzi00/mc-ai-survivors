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
    const { thought: _t, skill: _s, action: _a, ...rest } = o;
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

/** Deterministic fallback when the model fails twice: get wood if poor, otherwise explore. */
export function fallbackAction(logCount: number): PlannedAction {
  if (logCount < 8) return { thought: '(fallback) gather wood', skill: 'gather', args: { block: 'log', count: 4 } };
  return { thought: '(fallback) explore', skill: 'explore', args: { distance: 40 } };
}
