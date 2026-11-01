import pathfinderPkg from 'mineflayer-pathfinder';
import { sleep, throwIfAborted } from '../../util/time.js';
import type { SkillArgsOf } from '../schemas.js';
import type { SkillContext } from '../context.js';
import { fmtPos, gotoNear, gotoXZ } from '../helpers.js';
import { goSurface, isUnderground } from '../helpers.js';

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
  const p = ctx.bot.entity.position;
  const d = Math.hypot(p.x - x, p.z - z);
  // Report the truth: the pathfinder can "finish" short of the goal.
  return d <= 3 ? `arrived near ${fmtPos(p)}` : `stopped at ${fmtPos(p)}, ${Math.round(d)} blocks short of the target (blocked?)`;
}

export async function exploreSkill(ctx: SkillContext, a: SkillArgsOf<'explore'>): Promise<string> {
  // Exploring through caves fails ("took too long to decide path"): get to the surface first.
  if (isUnderground(ctx.bot)) {
    const r = await goSurface(ctx);
    if (isUnderground(ctx.bot)) return `underground and could not explore: ${r}`;
  }
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
  // Bots following bots did nothing useful (one bot spent most of its time walking behind the other).
  // Following humans is fine (e.g. "follow me").
  if (a.player.startsWith(ctx.config.population.namePrefix)) {
    return `following another bot wastes time: split the work and do a DIFFERENT task than ${a.player} (e.g. they gather wood, you hunt or mine stone). Use say to agree who does what`;
  }
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

export async function goSurfaceSkill(ctx: SkillContext): Promise<string> {
  return goSurface(ctx);
}
