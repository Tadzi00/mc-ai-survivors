/** Pure reflex arbitration (unit-tested). The agent gathers the state, this picks ONE reflex. */
export interface ReflexState {
  health: number; // 0-20
  food: number; // 0-20
  oxygen: number; // 0-20
  hasFood: boolean;
  inLava: boolean;
  onFire: boolean;
  inWater: boolean;
  hostile?: { distance: number; type: string };
  /** Night, under open sky, not bunkered: mobs will come. */
  nightExposed?: boolean;
  /** Day and the bot is still in its night bunker. */
  bunkeredAtDay?: boolean;
  /** An animal to eat is visible within 48 blocks or remembered. */
  preyKnown?: boolean;
  /** Food items carried (a reserve, not just "any"). */
  foodItems?: number;
  /** An animal to eat is visible within 24 blocks right now. */
  preyNear?: boolean;
  /** A teammate's HELP shout heard recently (distance to the given coordinates). */
  helpCall?: { distance: number };
  /** Hostile mobs within 10 blocks (defaults to 1 when a hostile is known). */
  nearbyHostiles?: number;
  hasWeapon: boolean;
  isNight: boolean;
  isSleeping: boolean;
  bedKnown: boolean;
  /** undefined when seasons are disabled or unknown. */
  cold?: boolean;
  hasTorch: boolean;
  homeKnown: boolean;
}

export type Reflex =
  | 'escape_lava'
  | 'extinguish'
  | 'surface'
  | 'fight'
  | 'flee'
  | 'assist'
  | 'hunt'
  | 'night_shelter'
  | 'leave_bunker'
  | 'eat'
  | 'warm_torch'
  | 'warm_home'
  | 'sleep';

export function chooseReflex(s: ReflexState): Reflex | null {
  if (s.inLava) return 'escape_lava';
  if (s.onFire) return 'extinguish';
  if (s.inWater && s.oxygen < 12) return 'surface';
  if (s.hostile && s.hostile.distance <= 8) {
    if (s.hostile.type === 'creeper') return s.health >= 16 && s.hasWeapon ? 'fight' : 'flee';
    // With a weapon: fight while reasonably healthy. Bare-handed: only at (nearly) full health vs ONE mob;
    // fists lose against a zombie most of the time.
    const many = (s.nearbyHostiles ?? 1) > 1;
    const fight = s.hasWeapon ? s.health >= 10 && !(many && s.health < 16) : s.health >= 18 && !many;
    return fight ? 'fight' : 'flee';
  }
  // Run to a teammate who shouted HELP (no model call: speed matters). Only when healthy enough.
  if (s.helpCall && s.helpCall.distance > 4 && s.helpCall.distance <= 150 && s.health >= 12) return 'assist';
  if (s.hasFood && (s.food <= 14 || (s.health < 12 && s.food < 20))) return 'eat';
  // Starving with nothing to eat: go get food NOW (the model kept gathering wood until it starved).
  if (!s.hasFood && s.food <= 6 && s.preyKnown) return 'hunt';
  // Keep a reserve: in daylight with an animal in sight, stock up before hunger becomes an emergency.
  if (s.foodItems !== undefined && s.foodItems < 3 && s.food <= 18 && s.preyNear && !s.isNight && !s.hostile) return 'hunt';
  if (s.cold === true) {
    if (s.homeKnown) return 'warm_home';
    if (s.hasTorch) return 'warm_torch';
  }
  if (s.bunkeredAtDay) return 'leave_bunker';
  if (s.isNight && !s.isSleeping && s.bedKnown && !s.hostile) return 'sleep';
  // Most deaths were zombies at night in the open: get home or dig in.
  if (s.nightExposed && !s.isSleeping) return 'night_shelter';
  return null;
}
