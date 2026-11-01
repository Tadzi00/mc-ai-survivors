// Door preference for the pathfinder (pure logic, no mineflayer imports).
//
// Opening a door costs the pathfinder nothing, but digging a natural block (dirt, stone, cobblestone wall)
// only costs ~2-4, so a 2-block hole through a wall beat walking a few blocks round to the door.
// Near a known door every dug block gets an extra penalty, so the route through the door wins unless
// the detour is really long (about DOOR_DIG_PENALTY blocks per block that would be dug).

export interface P3 { x: number; y: number; z: number }

/** Extra pathfinder cost per block dug near a door (≈ blocks of detour the bot will walk instead). */
export const DOOR_DIG_PENALTY = 12;
/** Horizontal reach of a door's "use me instead of digging" zone. */
export const DOOR_ZONE_RADIUS = 10;
/** Vertical reach (a door's wall plus roof, a floor below). */
export const DOOR_ZONE_DY = 4;

/** Penalty for digging block `p`, given known door positions. 0 when no door is close. */
export function doorDigPenalty(
  p: P3,
  doors: readonly P3[],
  radius = DOOR_ZONE_RADIUS,
  dy = DOOR_ZONE_DY,
  penalty = DOOR_DIG_PENALTY,
): number {
  for (const d of doors) {
    if (Math.abs(p.x - d.x) <= radius && Math.abs(p.z - d.z) <= radius && Math.abs(p.y - d.y) <= dy) return penalty;
  }
  return 0;
}
