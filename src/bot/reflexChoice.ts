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
  | 'eat'
  | 'warm_torch'
  | 'warm_home'
  | 'sleep';

export function chooseReflex(s: ReflexState): Reflex | null {
  if (s.inLava) return 'escape_lava';
  if (s.onFire) return 'extinguish';
  if (s.inWater && s.oxygen < 12) return 'surface';
  if (s.hostile && s.hostile.distance <= 8) {
    const strong = s.health >= 12 && (s.hasWeapon || s.hostile.type !== 'creeper');
    if (s.hostile.type === 'creeper') return s.health >= 16 && s.hasWeapon ? 'fight' : 'flee';
    return strong ? 'fight' : 'flee';
  }
  if (s.hasFood && (s.food <= 14 || (s.health < 12 && s.food < 20))) return 'eat';
  if (s.cold === true) {
    if (s.homeKnown) return 'warm_home';
    if (s.hasTorch) return 'warm_torch';
  }
  if (s.isNight && !s.isSleeping && s.bedKnown && !s.hostile) return 'sleep';
  return null;
}
