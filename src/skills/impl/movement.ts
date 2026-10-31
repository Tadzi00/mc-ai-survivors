import pathfinderPkg from 'mineflayer-pathfinder';
import { sleep, throwIfAborted } from '../../util/time.js';
import type { SkillArgsOf } from '../schemas.js';
import type { SkillContext } from '../context.js';
import { fmtPos, gotoNear, gotoXZ } from '../helpers.js';

const { goals } = pathfinderPkg;

const DIRS: Record<string, [number, number]> = {
  north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
  northeast: [0.7, -0.7], northwest: [-0.7, -0.7], southeast: [0.7, 0.7], southwest: [-0.7, 0.7],
};

export async function gotoSkill(ctx: SkillContext, a: SkillArgsOf<'goto'>): Promise<string> {
  let x = a.x, y = a.y, z = a.z;
  if (a.place) {
    const p = ctx.memory.place(a.place);
    if (!p) return `unknown place "${a.place}". Known: ${Object.keys(ctx.memory.data.places).join(', ') || 'none'}`;
    ({ x, y, z } = p);
  }
  if (x === undefined || z === undefined) return 'need coordinates';
  if (y === undefined) {
    await gotoXZ(ctx, x, z, 90_000);
  } else {
    await gotoNear(ctx, x, y, z, 1, 90_000);
  }
  return `arrived near ${fmtPos(ctx.bot.entity.position)}`;
}

export async function exploreSkill(ctx: SkillContext, a: SkillArgsOf<'explore'>): Promise<string> {
  const names = Object.keys(DIRS);
  const dir = a.direction ?? names[Math.floor(Math.random() * names.length)]!;
  const [dx, dz] = DIRS[dir]!;
  const p = ctx.bot.entity.position;
  const tx = Math.round(p.x + dx * a.distance);
  const tz = Math.round(p.z + dz * a.distance);
  try {
    await gotoXZ(ctx, tx, tz, 60_000);
  } catch (e) {
    throwIfAborted(ctx.signal);
    return `explored ${dir} partially, now at ${fmtPos(ctx.bot.entity.position)} (${(e as Error).message})`;
  }
  return `explored ${dir}, now at ${fmtPos(ctx.bot.entity.position)}`;
}

export async function followSkill(ctx: SkillContext, a: SkillArgsOf<'follow'>): Promise<string> {
  const { bot } = ctx;
  const target = bot.players[a.player]?.entity;
  if (!target) return `${a.player} is not visible nearby`;
  bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
  try {
    await sleep(a.seconds * 1000, ctx.signal);
  } finally {
    bot.pathfinder.setGoal(null);
  }
  return `followed ${a.player} for ${a.seconds}s`;
}
