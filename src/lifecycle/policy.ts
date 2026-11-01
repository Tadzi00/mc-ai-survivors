/**
 * Pure population policy (unit-tested). See DESIGN.md "Spawn rule" and "Smart-slot inheritance".
 */
import type { BedPos, CanSpawnResult } from '../contracts.js';

export type Tier = 'smart' | 'basic';

export type SpawnDecision =
  | { action: 'none'; reason: string }
  | { action: 'seed'; count: number; reason: string }
  | { action: 'spawn'; bed: BedPos; reason: string };

export interface SpawnInput {
  aliveCount: number;
  maxBots: number;
  initialBots: number;
  reseedWhenExtinct: boolean;
  /** Has any bot ever been spawned (from persisted state)? */
  everSpawned: boolean;
  /** Bridge answer; undefined when the bridge could not be queried. */
  canSpawn?: CanSpawnResult;
  /** Births so far in the current Minecraft day, and the daily limit (0 = no limit). */
  birthsToday?: number;
  maxBirthsPerDay?: number;
  /** Is a living bot near that free bed (to welcome and teach the newborn)? */
  botNearBed?: (bed: BedPos) => boolean;
}

export function decideSpawn(i: SpawnInput): SpawnDecision {
  if (i.aliveCount === 0) {
    const count = Math.min(i.initialBots, i.maxBots);
    if (!i.everSpawned) return { action: 'seed', count, reason: 'initial_seed' };
    if (i.reseedWhenExtinct) return { action: 'seed', count, reason: 'reseed_after_extinction' };
    return { action: 'none', reason: 'extinct' };
  }
  if (i.aliveCount >= i.maxBots) return { action: 'none', reason: 'max_bots' };
  if (!i.canSpawn) return { action: 'none', reason: 'bridge_unavailable' };
  if (!i.canSpawn.canSpawn) return { action: 'none', reason: i.canSpawn.reason || 'bridge_says_no' };
  if (!i.canSpawn.freeValidBed) return { action: 'none', reason: 'no_free_valid_bed' };
  if (i.maxBirthsPerDay && (i.birthsToday ?? 0) >= i.maxBirthsPerDay) return { action: 'none', reason: 'daily_birth_limit' };
  // A newborn needs someone to meet it: no births at a bed nobody is near.
  if (i.botNearBed && !i.botNearBed(i.canSpawn.freeValidBed)) return { action: 'none', reason: 'nobody_near_the_bed' };
  return { action: 'spawn', bed: i.canSpawn.freeValidBed, reason: 'shelter_rule_met' };
}

/**
 * The next bot is smart iff fewer than `smartSlots` living bots are smart. A dead smart bot frees
 * its slot; existing basic bots are NOT promoted — the next newborn inherits the slot.
 */
export function assignTier(aliveTiers: readonly Tier[], smartSlots: number): Tier {
  const smart = aliveTiers.filter((t) => t === 'smart').length;
  return smart < smartSlots ? 'smart' : 'basic';
}

/** Tiers for a batch of new bots, applied sequentially. */
export function assignTiers(aliveTiers: readonly Tier[], smartSlots: number, n: number): Tier[] {
  const acc = [...aliveTiers];
  const out: Tier[] = [];
  for (let k = 0; k < n; k++) {
    const t = assignTier(acc, smartSlots);
    acc.push(t);
    out.push(t);
  }
  return out;
}

/** Names are never reused: Surv_01, Surv_02, ... skipping anything already used. */
export function nextBotName(prefix: string, counter: number, used: ReadonlySet<string>): { name: string; counter: number } {
  let n = counter;
  for (;;) {
    n++;
    const name = `${prefix}${String(n).padStart(2, '0')}`;
    if (!used.has(name.toLowerCase())) return { name, counter: n };
  }
}
