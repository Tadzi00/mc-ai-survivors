import type { Block } from 'prismarine-block';
import type { Recipe } from 'prismarine-recipe';
import type { CommandRunner } from '../../rcon/rcon.js';
import type { Bot } from 'mineflayer';
import { AbortError, sleep, throwIfAborted, withTimeout } from '../../util/time.js';
import type { SkillArgsOf } from '../schemas.js';
import type { SkillContext } from '../context.js';
import { countItem, findBlocks, findItem, freeSpotNearBot, gotoNear, isTreeLog, nearManMade, nearestBlock, placeItemAt, resolveBlockNames } from '../helpers.js';

/** Name of the item a block usually drops (for counting progress). */
function dropNameFor(blockName: string): RegExp {
  if (blockName === 'stone') return /^cobblestone$/;
  if (blockName === 'grass_block') return /^dirt$/;
  if (blockName.endsWith('_ore')) {
    const base = blockName.replace(/^deepslate_/, '').replace(/_ore$/, '');
    const map: Record<string, string> = { coal: 'coal', iron: 'raw_iron', gold: 'raw_gold', copper: 'raw_copper', diamond: 'diamond', redstone: 'redstone', lapis: 'lapis_lazuli', emerald: 'emerald' };
    return new RegExp(`^${map[base] ?? base}$`);
  }
  return new RegExp(`^${blockName}$`);
}

/** Blocks a bot recently failed to collect (pos key -> retry-after time). Kept across gather calls. */
const SKIP_MS = 5 * 60_000;
const unreachable = new WeakMap<Bot, Map<string, number>>();
function unreachableFor(bot: Bot): Map<string, number> {
  let m = unreachable.get(bot);
  if (!m) unreachable.set(bot, (m = new Map()));
  return m;
}
const posKey = (b: Block): string => `${b.position.x},${b.position.y},${b.position.z}`;
/** Distance, plus a heavy penalty for blocks well above our feet (canopy logs, cliff faces). */
function targetCost(bot: Bot, b: Block, feetY: number): number {
  return bot.entity.position.distanceTo(b.position) + 4 * Math.max(0, b.position.y - feetY - 2);
}

export async function gatherSkill(ctx: SkillContext, a: SkillArgsOf<'gather'>): Promise<string> {
  const { bot } = ctx;
  const names = resolveBlockNames(bot, a.block);
  if (names.length === 0) return `unknown block "${a.block}"`;
  const dropRes = names.map(dropNameFor);
  const counter = (): number => bot.inventory.items().filter((i) => dropRes.some((r) => r.test(i.name))).reduce((n, i) => n + i.count, 0);
  const start = counter();
  let failures = 0;
  const bonus: Record<string, number> = {};
  const onAbort = (): void => void bot.collectBlock.cancelTask().catch(() => undefined);
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const skip = unreachableFor(bot);
  try {
    while (counter() - start < a.count && failures < 4) {
      throwIfAborted(ctx.signal);
      const now = Date.now();
      for (const [k, until] of skip) if (until < now) skip.delete(k);
      const feetY = bot.entity.position.y;
      // Skip blocks we recently failed to reach, and prefer ones near our own height
      // (tree trunks over canopy logs, which pathfinding often can't reach).
      const isLog = names.every((n) => /_log$|_stem$/.test(n));
      const targets = findBlocks(bot, names, 64, 32)
        .filter((b) => b.position.y > -60 && !skip.has(posKey(b)))
        // never take blocks from buildings: logs must be trees; nothing inside protected areas
        .filter((b) => !ctx.protectedAreas?.contains(b.position) && (isLog ? isTreeLog(bot, b) : !nearManMade(bot, b.position, 1)))
        .sort((p, q) => targetCost(bot, p, feetY) - targetCost(bot, q, feetY));
      if (targets.length === 0) break;
      const target = targets[0]!;
      // Blocks with harvestTools (stone, ores) drop nothing without a suitable tool.
      if (target.harvestTools && !Object.keys(target.harvestTools).some((id) => bot.inventory.items().some((i) => String(i.type) === id))) {
        return `need a better tool to harvest ${target.name} (craft a pickaxe)`;
      }
      const before = counter();
      try {
        await withTimeout(bot.collectBlock.collect(target, { ignoreNoPath: true }), 20_000, 'collect');
        if (counter() === before) skip.set(posKey(target), Date.now() + SKIP_MS);
        await grabValuableOres(ctx, names, skip, bonus);
      } catch (e) {
        if (ctx.signal.aborted) throw new AbortError();
        failures++;
        skip.set(posKey(target), Date.now() + SKIP_MS);
        // Never await cancelTask: it waits for the task to wind down and can hang if pathfinding is stuck.
        void bot.collectBlock.cancelTask().catch(() => undefined);
        bot.pathfinder.stop();
        ctx.log(`collect failed at ${posKey(target)}: ${(e as Error).message}`);
      }
    }
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
  const got = counter() - start;
  const extra = Object.entries(bonus).map(([k, v]) => `${v} ${k}`).join(', ');
  const also = extra ? `; also mined ${extra} found on the way` : '';
  if (got === 0) return `found no reachable ${a.block} nearby (try explore)${also}`;
  return `gathered ${got} ${a.block} (wanted ${a.count})${also}`;
}

/**
 * Valuable ores a bot always takes when it passes them, whatever it is gathering (most valuable first).
 * E.g. hunting copper and seeing iron within 8 blocks -> mine the iron too, then continue.
 */
const VALUABLE_ORES = [
  'diamond_ore', 'deepslate_diamond_ore', 'iron_ore', 'deepslate_iron_ore', 'gold_ore', 'deepslate_gold_ore',
  'coal_ore', 'deepslate_coal_ore', 'copper_ore', 'deepslate_copper_ore', 'redstone_ore', 'lapis_ore',
];
const MAX_BONUS_PER_GATHER = 8;

async function grabValuableOres(ctx: SkillContext, gathering: string[], skip: Map<string, number>, bonus: Record<string, number>): Promise<void> {
  const { bot } = ctx;
  const wanted = VALUABLE_ORES.filter((o) => !gathering.includes(o) && bot.registry.blocksByName[o]);
  for (let i = 0; i < 3; i++) {
    if (Object.values(bonus).reduce((n, v) => n + v, 0) >= MAX_BONUS_PER_GATHER) return;
    throwIfAborted(ctx.signal);
    const ore = findBlocks(bot, wanted, 8, 8)
      .filter((b) => !skip.has(posKey(b)))
      // only ores our tools can actually harvest, most valuable first
      .filter((b) => !b.harvestTools || Object.keys(b.harvestTools).some((id) => bot.inventory.items().some((it) => String(it.type) === id)))
      .sort((p, q) => VALUABLE_ORES.indexOf(p.name) - VALUABLE_ORES.indexOf(q.name))[0];
    if (!ore) return;
    try {
      await withTimeout(bot.collectBlock.collect(ore, { ignoreNoPath: true }), 15_000, 'collect');
      const k = ore.name.replace(/^deepslate_/, '');
      bonus[k] = (bonus[k] ?? 0) + 1;
      ctx.memory.discover(k, ore.position);
    } catch {
      if (ctx.signal.aborted) throw new AbortError();
      skip.set(posKey(ore), Date.now() + SKIP_MS);
      void bot.collectBlock.cancelTask().catch(() => undefined);
    }
  }
}

/** Crafting tables we could not reach (position keys). */
const badTables = new Set<string>();

/** Why the last ensureCraftingTable call failed (shown to the model), per bot. */
const tableProblem = new WeakMap<Bot, string>();

/** Finds a crafting table within 24 blocks, or crafts+places one. */
export async function ensureCraftingTable(ctx: SkillContext): Promise<Block | undefined> {
  const { bot } = ctx;
  tableProblem.delete(bot);
  // Use a table that is already in reach, or one we can walk to quickly; tables other bots left on trees
  // or ledges used to make every craft time out.
  const existing = findBlocks(bot, ['crafting_table'], 24, 6).filter((b) => !badTables.has(posKey(b)));
  for (const t of existing) {
    if (bot.entity.position.distanceTo(t.position.offset(0.5, 0.5, 0.5)) <= 4) return t;
  }
  for (const t of existing.slice(0, 2)) {
    try {
      await gotoNear(ctx, t.position.x, t.position.y, t.position.z, 2, 10_000);
      if (bot.entity.position.distanceTo(t.position.offset(0.5, 0.5, 0.5)) <= 4.5) return t;
    } catch {
      if (ctx.signal.aborted) throw new AbortError();
    }
    badTables.add(posKey(t)); // unreachable: don't try it again this session
  }
  if (countItem(bot, 'crafting_table') === 0) {
    if (countItem(bot, /_planks$/) < 4) await craftPlanksFromLogs(bot, 1);
    const id = bot.registry.itemsByName.crafting_table!.id;
    const r = bot.recipesFor(id, null, 1, null)[0];
    if (!r) {
      tableProblem.set(bot, 'no crafting table and not enough planks to make one (4 planks)');
      return undefined;
    }
    await craftClean(bot, r, 1, undefined);
    await sleep(300);
  }
  const item = findItem(bot, 'crafting_table');
  if (!item) {
    tableProblem.set(bot, 'crafting a crafting table failed');
    return undefined;
  }
  const spot = freeSpotNearBot(bot);
  if (!spot) {
    tableProblem.set(bot, 'no free spot to place the crafting table here; move to open flat ground (explore) and retry');
    return undefined;
  }
  if (!(await placeItemAt(ctx, item, spot))) {
    tableProblem.set(bot, `could not place the crafting table at ${spot.x},${spot.y},${spot.z}; move a few blocks and retry`);
    return undefined;
  }
  ctx.memory.setPlace('crafting_table', spot);
  return bot.blockAt(spot) ?? undefined;
}

async function craftPlanksFromLogs(bot: Bot, times: number): Promise<boolean> {
  const log = findItem(bot, /_log$/);
  if (!log) return false;
  const plankName = log.name.replace(/_log$/, '_planks');
  const plank = bot.registry.itemsByName[plankName] ?? bot.registry.itemsByName.oak_planks;
  if (!plank) return false;
  const r = bot.recipesFor(plank.id, null, 1, null)[0];
  if (!r) return false;
  await craftClean(bot, r, Math.min(times, log.count), undefined);
  return true;
}

async function autoIntermediates(ctx: SkillContext, itemName: string): Promise<void> {
  const { bot } = ctx;
  // Simple, common prerequisites so cheap models don't have to plan them.
  if (countItem(bot, /_planks$/) < 8) await craftPlanksFromLogs(bot, 2).catch(() => false);
  if (/stick|pickaxe|axe|shovel|hoe|sword|torch|sign/.test(itemName) && countItem(bot, 'stick') < 4) {
    const r = bot.recipesFor(bot.registry.itemsByName.stick!.id, null, 1, null)[0];
    if (r) await craftClean(bot, r, 1, undefined).catch(() => undefined);
  }
}

/**
 * A failed/partial craft can leave items in the player's 2x2 crafting grid (inventory slots 1-4). Four planks
 * there silently become a crafting table on the next craft, so always move leftovers back to the inventory.
 */
async function clearCraftingGrid(bot: Bot): Promise<void> {
  for (const slot of [1, 2, 3, 4]) {
    if (!bot.inventory.slots[slot]) continue;
    try {
      await bot.clickWindow(slot, 0, 1); // shift-click: move to inventory
    } catch {
      /* ignore: best effort */
    }
  }
}

/** Every craft goes through here: grid emptied before and after, so leftovers can't become buttons/tables. */
async function craftClean(bot: Bot, recipe: Recipe, times: number, table: Block | null | undefined): Promise<void> {
  const srv = serverCrafting.get(bot);
  if (srv) return serverCraft(bot, recipe, times, table, srv);
  await clearCraftingGrid(bot);
  try {
    await bot.craft(recipe, times, table ?? undefined);
  } finally {
    await clearCraftingGrid(bot);
  }
}

/**
 * SERVER-SIDE CRAFTING (default, see DESIGN.md): mineflayer's window-click crafting desyncs on 1.21.x
 * (count-0 ghost stacks, planks turning into buttons, items dropped on the ground). Instead we check the
 * same rules (ingredients in the inventory; a placed crafting table within reach for 3x3 recipes) and let
 * the server swap ingredients for the result over RCON in one go, rolling back on any shortfall.
 */
const serverCrafting = new WeakMap<Bot, { name: string; rcon: CommandRunner }>();

export function enableServerCrafting(bot: Bot, name: string, rcon: CommandRunner): void {
  serverCrafting.set(bot, { name, rcon });
}

async function serverCraft(bot: Bot, recipe: Recipe, times: number, table: Block | null | undefined, srv: { name: string; rcon: CommandRunner }): Promise<void> {
  if (recipe.requiresTable && (!table || bot.entity.position.distanceTo(table.position.offset(0.5, 0.5, 0.5)) > 4.5)) {
    throw new Error('crafting table not within reach');
  }
  const need = new Map<string, number>();
  for (const d of recipe.delta) {
    if (d.count >= 0) continue;
    const n = bot.registry.items[d.id]?.name;
    if (!n) throw new Error('unknown ingredient');
    need.set(n, (need.get(n) ?? 0) + -d.count * times);
  }
  for (const [n, c] of need) if (countItem(bot, n) < c) throw new Error('missing ingredient');
  const removed: Array<[string, number]> = [];
  const rollback = async (): Promise<void> => {
    for (const [n, c] of removed) await srv.rcon.send(`give ${srv.name} minecraft:${n} ${c}`).catch(() => undefined);
  };
  for (const [n, c] of need) {
    const out = await srv.rcon.send(`clear ${srv.name} minecraft:${n} ${c}`);
    const got = Number(/Removed (\d+)/i.exec(out)?.[1] ?? 0);
    if (got > 0) removed.push([n, got]);
    if (got < c) {
      await rollback();
      throw new Error('missing ingredient');
    }
  }
  const result = bot.registry.items[recipe.result.id]?.name;
  if (!result) {
    await rollback();
    throw new Error('unknown result');
  }
  await srv.rcon.send(`give ${srv.name} minecraft:${result} ${recipe.result.count * times}`);
}

/**
 * bot.craft right after another craft often fails with "missing ingredient" because the client inventory
 * hasn't caught up with the server yet. Wait a bit, re-pick the recipe and retry.
 */
async function craftWithRetry(ctx: SkillContext, itemId: number, first: Recipe, times: number, table: Block | undefined): Promise<void> {
  const { bot } = ctx;
  let recipe = first;
  for (let i = 0; ; i++) {
    try {
      await craftClean(bot, recipe, times, table);
      return;
    } catch (e) {
      if (i >= 2 || !/missing ingredient/i.test((e as Error).message)) throw e;
      throwIfAborted(ctx.signal);
      await sleep(500 * (i + 1));
      recipe = bot.recipesFor(itemId, null, 1, table ?? null)[0] ?? recipe;
    }
  }
}

/** "oak_planks" -> "planks (any wood)": recipes accept any wood type, so don't name a random one. */
function genericWood(name: string): string {
  if (/_planks$/.test(name)) return 'planks (any wood, craft from logs)';
  if (/_log$/.test(name)) return 'logs (any wood)';
  return name;
}

/**
 * Maps wood-specific requests to the wood the bot actually has: "planks" / "pale_oak_planks" with only
 * spruce logs -> "spruce_planks". Other names pass through.
 */
function woodAlias(bot: Bot, name: string): string {
  // Bare tool names ("pickaxe", "sword") -> best tier the bot has material for.
  const tool = /^(pickaxe|axe|sword|shovel|hoe)$/.exec(name);
  if (tool) {
    const tier = countItem(bot, 'iron_ingot') >= 3 ? 'iron' : countItem(bot, /^(cobblestone|cobbled_deepslate|blackstone)$/) >= 3 ? 'stone' : 'wooden';
    return `${tier}_${tool[1]}`;
  }
  const m = /^(?:(\w+?)_)?(planks|slab|stairs|fence|fence_gate|door|trapdoor|button|pressure_plate|sign|boat)$/.exec(name);
  if (!m) return name;
  const kind = m[2]!;
  const requestedWood = m[1];
  const has = (wood: string): boolean => countItem(bot, `${wood}_log`) > 0 || countItem(bot, `${wood}_planks`) > 0;
  if (requestedWood && has(requestedWood)) return name;
  const own = bot.inventory.items().find((i) => /_(log|planks)$/.test(i.name));
  const wood = own?.name.replace(/_(log|planks)$/, '');
  if (!wood) return requestedWood ? name : `oak_${kind}`;
  const candidate = `${wood}_${kind}`;
  return bot.registry.itemsByName[candidate] ? candidate : name;
}

export async function craftSkill(ctx: SkillContext, a: SkillArgsOf<'craft'>): Promise<string> {
  const { bot } = ctx;
  const item = bot.registry.itemsByName[woodAlias(bot, a.item.toLowerCase().replace(/^minecraft:/, ''))];
  if (!item) return `unknown item "${a.item}"`;
  if (item.name === 'crafting_table') {
    const have = countItem(bot, 'crafting_table');
    if (have > 0) return `you already have ${have} crafting_table in your inventory; craft tools directly (a table is placed automatically)`;
    if (nearestBlock(bot, ['crafting_table'], 24)) return 'a crafting_table is already placed nearby; craft tools directly';
  }
  await clearCraftingGrid(bot);
  const before = countItem(bot, item.name);
  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfAborted(ctx.signal);
    let recipe = bot.recipesFor(item.id, null, 1, null)[0];
    let table: Block | undefined;
    if (!recipe) {
      const needsTable = bot.recipesAll(item.id, null, true).length > 0;
      if (needsTable) {
        table = await ensureCraftingTable(ctx);
        if (table) {
          // Crafting only needs the table within reach; walking "near" a table we just placed next to us
          // can make the pathfinder hang.
          if (bot.entity.position.distanceTo(table.position.offset(0.5, 0.5, 0.5)) > 4) {
            await gotoNear(ctx, table.position.x, table.position.y, table.position.z, 2, 30_000);
          }
          recipe = bot.recipesFor(item.id, null, 1, table)[0];
        }
      }
    }
    if (recipe) {
      const times = Math.ceil(a.count / recipe.result.count);
      await craftWithRetry(ctx, item.id, recipe, times, table);
      // The inventory update arrives after the craft resolves: wait up to 1.5 s, then report the TRUTH.
      let made = 0;
      for (let i = 0; i < 6 && made <= 0; i++) {
        await sleep(250);
        made = countItem(bot, item.name) - before;
      }
      if (made <= 0) return `cannot craft ${item.name}: the craft did not go through (nothing was made); try again or move`;
      return `crafted ${made} ${item.name} (now have ${countItem(bot, item.name)})`;
    }
    if (attempt === 0) {
      await autoIntermediates(ctx, item.name);
      await sleep(400); // let the inventory sync after crafting intermediates
    }
  }
  // Explain what's actually missing: ingredients we don't have enough of, and/or the table problem.
  const any = bot.recipesAll(item.id, null, true)[0];
  if (!any) return `no known recipe for ${item.name}`;
  const have = (id: number): number => {
    const n = bot.registry.items[id]?.name ?? '';
    // any wood type counts for planks/logs
    if (/_planks$/.test(n)) return countItem(bot, /_planks$/);
    if (/_log$/.test(n)) return countItem(bot, /_log$/);
    return countItem(bot, n);
  };
  const missing = any.delta
    .filter((d) => d.count < 0 && have(d.id) < -d.count)
    .map((d) => `${-d.count - have(d.id)} more ${genericWood(bot.registry.items[d.id]?.name ?? String(d.id))}`);
  const problems = [...missing];
  if (any.requiresTable && tableProblem.get(bot)) problems.push(`crafting table: ${tableProblem.get(bot)}`);
  if (problems.length === 0) problems.push('unknown reason (try again)');
  return `cannot craft ${item.name}: ${problems.join('; ')}`;
}

const SMELT_INPUT: Record<string, string> = {
  iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper', glass: 'sand', stone: 'cobblestone',
  charcoal: 'oak_log', cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_chicken: 'chicken',
  cooked_mutton: 'mutton', cooked_rabbit: 'rabbit', cooked_cod: 'cod', cooked_salmon: 'salmon', baked_potato: 'potato',
  smooth_stone: 'stone', brick: 'clay_ball',
};

export async function smeltSkill(ctx: SkillContext, a: SkillArgsOf<'smelt'>): Promise<string> {
  const { bot } = ctx;
  let inputName = a.item.toLowerCase();
  if (SMELT_INPUT[inputName]) inputName = SMELT_INPUT[inputName]!;
  if (inputName === 'oak_log') inputName = findItem(bot, /_log$/)?.name ?? 'oak_log';
  const input = findItem(bot, inputName);
  if (!input) return `no ${inputName} in inventory to smelt`;
  const n = Math.min(a.count, input.count);

  let furnaceBlock = nearestBlock(bot, ['furnace'], 24);
  if (!furnaceBlock) {
    if (countItem(bot, 'furnace') === 0) {
      const r = await craftSkill(ctx, { item: 'furnace', count: 1 });
      if (!r.startsWith('crafted')) return `no furnace: ${r}`;
    }
    const spot = freeSpotNearBot(bot);
    const f = findItem(bot, 'furnace');
    if (!spot || !f || !(await placeItemAt(ctx, f, spot))) return 'could not place a furnace';
    furnaceBlock = bot.blockAt(spot) ?? undefined;
    if (!furnaceBlock) return 'furnace vanished';
    ctx.memory.setPlace('furnace', spot);
  }
  await gotoNear(ctx, furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2, 30_000);

  const fuelPick = a.fuel
    ? findItem(bot, a.fuel)
    : (findItem(bot, 'coal') ?? findItem(bot, 'charcoal') ?? findItem(bot, /_planks$/) ?? findItem(bot, /_log$/));
  if (!fuelPick) return 'no fuel (coal, charcoal, planks or logs)';
  const perFuel = /coal/.test(fuelPick.name) ? 8 : /_log$|_planks$/.test(fuelPick.name) ? 1.5 : 1;
  const fuelCount = Math.min(fuelPick.count, Math.ceil(n / perFuel));

  const furnace = await bot.openFurnace(furnaceBlock);
  let taken = 0;
  try {
    await furnace.putFuel(fuelPick.type, null, fuelCount);
    await furnace.putInput(input.type, null, n);
    const deadline = Date.now() + Math.min(n * 10_500 + 5_000, (ctx.config.bot.skillTimeoutSeconds - 10) * 1000);
    while (taken < n && Date.now() < deadline) {
      await sleep(2000, ctx.signal);
      if (furnace.outputItem()) {
        const out = await furnace.takeOutput();
        taken += out?.count ?? 0;
      }
    }
  } finally {
    furnace.close();
  }
  return `smelted ${taken}/${n} ${inputName}`;
}
