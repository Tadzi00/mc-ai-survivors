import type { SkillContext } from './context.js';
import type { SkillArgsOf, SkillName } from './schemas.js';
import { buildShelterSkill, placeBedSkill, placeBlockSkill, placeTorchSkill } from './impl/building.js';
import { farmSkill } from './impl/farm.js';
import {
  checkTemperatureSkill, markPlaceSkill, readBookSkill, readSignsSkill, rememberSkill, saySkill, shoutSkill, setGoalSkill, waitSkill, writeBookSkill, writeSignSkill,
} from './impl/knowledge.js';
import { exploreSkill, followSkill, gotoSkill } from './impl/movement.js';
import { craftSkill, gatherSkill, smeltSkill } from './impl/resources.js';
import { chestStoreSkill, chestTakeSkill, giveSkill } from './impl/storage.js';
import { attackSkill, eatSkill, sleepSkill } from './impl/survival.js';

type Registry = { [K in SkillName]: (ctx: SkillContext, args: SkillArgsOf<K>) => Promise<string> };

export const SKILLS: Registry = {
  gather: gatherSkill,
  craft: craftSkill,
  smelt: smeltSkill,
  goto: gotoSkill,
  explore: exploreSkill,
  follow: followSkill,
  attack: attackSkill,
  eat: eatSkill,
  sleep: sleepSkill,
  place_block: placeBlockSkill,
  build_shelter: buildShelterSkill,
  place_bed: placeBedSkill,
  place_torch: placeTorchSkill,
  farm: farmSkill,
  chest_store: chestStoreSkill,
  chest_take: chestTakeSkill,
  give: giveSkill,
  check_temperature: checkTemperatureSkill,
  say: saySkill,
  shout: shoutSkill,
  mark_place: markPlaceSkill,
  write_sign: writeSignSkill,
  read_signs: readSignsSkill,
  write_book: writeBookSkill,
  read_book: readBookSkill,
  remember: rememberSkill,
  set_goal: setGoalSkill,
  wait: waitSkill,
};

/** Runs a validated skill. `args` must already be parsed by the skill's zod schema. */
export function runSkill(ctx: SkillContext, name: SkillName, args: Record<string, unknown>): Promise<string> {
  const fn = SKILLS[name] as (ctx: SkillContext, a: Record<string, unknown>) => Promise<string>;
  return fn(ctx, args);
}
