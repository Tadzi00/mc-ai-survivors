// Scenarios for scripts/harness.mjs. Each gets (ctx, P) with P = { X, Y, Z, cmd, sleep, give, botName } and
// returns { ok, why }. The bot stands at (X, Y, Z) on a stone platform at Y-1. Check results via P.cmd (RCON).
import { writeSignSkill, readSignsSkill, writeBookSkill, readBookSkill } from '../dist/skills/impl/knowledge.js';
import { smeltSkill, gatherSkill, craftSkill } from '../dist/skills/impl/resources.js';
import { placeBedSkill, addDoorSkill, plantSaplingSkill, placeTorchSkill, heatRoomSkill } from '../dist/skills/impl/building.js';
import { sleepSkill, attackSkill, eatSkill } from '../dist/skills/impl/survival.js';
import { farmSkill } from '../dist/skills/impl/farm.js';
import { gotoSkill, goSurfaceSkill } from '../dist/skills/impl/movement.js';
import { chestStoreSkill, chestTakeSkill } from '../dist/skills/impl/storage.js';

const count = async (P, item) => Number(/Found (\d+)/.exec(await P.cmd(`clear ${P.botName} minecraft:${item} 0`))?.[1] ?? 0);
const isBlock = async (P, x, y, z, block) => /passed/i.test(await P.cmd(`execute if block ${x} ${y} ${z} ${block}`));
const ok = (cond, why) => ({ ok: !!cond, why });

/** Hollow stone room 5x5 (outer) around (X,Y,Z), floor at Y-1, roof at Y+3, with an oak door on the south wall. */
async function room(P, { door = true } = {}) {
  const { X, Y, Z } = P;
  await P.cmd(`fill ${X - 2} ${Y - 1} ${Z - 2} ${X + 2} ${Y + 3} ${Z + 2} minecraft:stone hollow`);
  if (door) {
    await P.cmd(`setblock ${X} ${Y} ${Z + 2} minecraft:oak_door[half=lower,facing=south]`);
    await P.cmd(`setblock ${X} ${Y + 1} ${Z + 2} minecraft:oak_door[half=upper,facing=south]`);
  }
  // RCON fills fire no block events, so RealisticSeasons' 5 s "outside" cache must expire on its own.
  await P.sleep(6000);
}

export const scenarios = {
  async signs(ctx, P) {
    await P.give('oak_sign', 2);
    await P.sleep(600);
    const w = await writeSignSkill(ctx, { text: 'Iron at 120 40 -5. Beware creepers!' });
    await P.sleep(800);
    const r = await readSignsSkill(ctx, { radius: 8 });
    return ok(/iron at 120/i.test(r) && /creeper/i.test(r), `write: ${w} | read: ${r.slice(0, 160)}`);
  },

  async books(ctx, P) {
    await P.give('writable_book', 1);
    await P.sleep(600);
    const w = await writeBookSkill(ctx, { title: 'Survival', pages: ['Cows live on grass.', 'Smelt raw iron in a furnace.'] });
    await P.sleep(800);
    const signed = await count(P, 'written_book');
    const r = await readBookSkill(ctx, { source: 'inventory' });
    return ok(signed === 1 && /cows live on grass/i.test(r), `write: ${w} | written_book=${signed} | read: ${r.slice(0, 160)}`);
  },

  async chest(ctx, P) {
    await P.cmd(`setblock ${P.X + 2} ${P.Y} ${P.Z} minecraft:chest`);
    await P.give('cobblestone', 20);
    await P.sleep(600);
    const s = await chestStoreSkill(ctx, { items: ['cobblestone:15'] });
    const t = await chestTakeSkill(ctx, { items: ['cobblestone:5'] });
    const mine = await count(P, 'cobblestone');
    return ok(mine === 10 && /stored 15/.test(s) && /took 5/.test(t), `store: ${s} | take: ${t.slice(0, 80)} | bot has ${mine}`);
  },

  async smelt(ctx, P) {
    await P.give('raw_iron', 3);
    await P.give('coal', 2);
    await P.give('cobblestone', 8);
    await P.give('crafting_table', 1);
    await P.sleep(800);
    const r = await smeltSkill(ctx, { item: 'iron_ingot', count: 3 });
    const ingots = await count(P, 'iron_ingot');
    return ok(ingots === 3, `result: ${r} | iron_ingot=${ingots}`);
  },

  async craft_tools(ctx, P) {
    await P.give('oak_log', 6);
    await P.give('cobblestone', 3);
    await P.sleep(800);
    const a = await craftSkill(ctx, { item: 'stone_pickaxe', count: 1 });
    const b = await craftSkill(ctx, { item: 'wooden_sword', count: 1 });
    const pk = await count(P, 'stone_pickaxe');
    const sw = await count(P, 'wooden_sword');
    return ok(pk === 1 && sw === 1, `${a} | ${b} | stone_pickaxe=${pk} wooden_sword=${sw}`);
  },

  async bed_claim(ctx, P) {
    await room(P);
    ctx.memory.setPlace('home', { x: P.X, y: P.Y, z: P.Z });
    await P.give('white_bed', 1);
    await P.sleep(800);
    const p = await placeBedSkill(ctx);
    await P.sleep(800);
    const s = await sleepSkill(ctx);
    await P.sleep(800);
    const beds = await P.cmd('survivors beds raw');
    const owned = beds.includes(`"owner":"${P.botName}"`);
    await P.cmd(`survivors unassign ${P.botName}`);
    return ok(owned, `place: ${p} | sleep: ${s} | owned=${owned}`);
  },

  async door_out(ctx, P) {
    await room(P);
    ctx.memory.setPlace('home', { x: P.X, y: P.Y, z: P.Z });
    const r = await gotoSkill(ctx, { x: P.X, y: P.Y, z: P.Z + 7 });
    const pos = ctx.bot.entity.position;
    const doorStill = await isBlock(P, P.X, P.Y, P.Z + 2, '#minecraft:doors');
    let holes = 0;
    for (let x = P.X - 2; x <= P.X + 2; x++) for (let y = P.Y; y <= P.Y + 2; y++) for (const z of [P.Z - 2, P.Z + 2]) {
      if (x === P.X && z === P.Z + 2 && y <= P.Y + 1) continue;
      if (await isBlock(P, x, y, z, 'minecraft:air')) holes++;
    }
    return ok(pos.z > P.Z + 4 && doorStill && holes === 0, `goto: ${r} | at z=${pos.z.toFixed(1)} | door=${doorStill} holes=${holes}`);
  },

  async door_in(ctx, P) {
    await room(P);
    ctx.memory.setPlace('home', { x: P.X, y: P.Y, z: P.Z });
    await P.cmd(`tp ${P.botName} ${P.X + 0.5} ${P.Y} ${P.Z + 6.5}`);
    await P.sleep(1200);
    const r = await gotoSkill(ctx, { place: 'home' });
    const pos = ctx.bot.entity.position;
    const inside = Math.abs(pos.x - (P.X + 0.5)) < 2 && Math.abs(pos.z - (P.Z + 0.5)) < 2;
    const doorStill = await isBlock(P, P.X, P.Y, P.Z + 2, '#minecraft:doors');
    return ok(inside && doorStill, `goto home: ${r} | at ${pos.x.toFixed(1)},${pos.z.toFixed(1)} | door=${doorStill}`);
  },

  async add_door(ctx, P) {
    await room(P, { door: false });
    ctx.memory.setPlace('home', { x: P.X, y: P.Y, z: P.Z });
    ctx.memory.setPlace('doorway', { x: P.X, y: P.Y, z: P.Z + 2 });
    await P.give('oak_planks', 10); // 6 for the door + 4 for a crafting table
    await P.sleep(800);
    const r = await addDoorSkill(ctx);
    const door = await isBlock(P, P.X, P.Y, P.Z + 2, '#minecraft:doors');
    return ok(door, `add_door: ${r} | door=${door}`);
  },

  async torch(ctx, P) {
    await P.give('torch', 2);
    await P.sleep(600);
    const r = await placeTorchSkill(ctx);
    return ok(/placed torch/.test(r), r);
  },

  async heat_room(ctx, P) {
    await room(P);
    await P.give('torch', 8);
    await P.sleep(1200);
    const r = await heatRoomSkill(ctx);
    const after = JSON.parse((await P.cmd(`room raw ${P.X} ${P.Y} ${P.Z}`)).split('|').pop());
    const eq = after.equilibriumC ?? after.tempC;
    let torches = 0;
    for (let x = P.X - 2; x <= P.X + 2; x++) for (let z = P.Z - 2; z <= P.Z + 2; z++) if (await isBlock(P, x, P.Y, z, 'minecraft:torch')) torches++;
    return ok(eq >= 12 && eq <= 28, `${r} | room now ${after.tempC}C, heading to ${eq}C | torches in room=${torches} sealed=${after.sealed} vol=${after.volume} leaks=${JSON.stringify(after.leaks)}`);
  },

  async hunt(ctx, P) {
    await P.give('stone_sword', 1);
    await P.cmd(`summon minecraft:cow ${P.X + 4} ${P.Y} ${P.Z} {NoAI:0b}`);
    await P.sleep(1500);
    const r = await attackSkill(ctx, { target: 'cow' });
    await P.sleep(2500);
    const beef = await count(P, 'beef');
    return ok(beef > 0, `attack: ${r} | beef=${beef}`);
  },

  async eat(ctx, P) {
    await P.cmd(`effect give ${P.botName} minecraft:hunger 3 255`);
    await P.sleep(3500);
    await P.give('bread', 3);
    await P.sleep(600);
    const before = ctx.bot.food;
    const r = await eatSkill(ctx);
    await P.sleep(800);
    return ok(ctx.bot.food > before, `eat: ${r} | food ${before} -> ${ctx.bot.food}`);
  },

  async sapling(ctx, P) {
    await P.cmd(`fill ${P.X - 4} ${P.Y - 1} ${P.Z - 4} ${P.X + 4} ${P.Y - 1} ${P.Z + 4} minecraft:grass_block`);
    await P.give('oak_sapling', 3);
    await P.sleep(800);
    const r = await plantSaplingSkill(ctx, { count: 2 });
    let n = 0;
    for (let x = P.X - 5; x <= P.X + 5; x++) for (let z = P.Z - 5; z <= P.Z + 5; z++) if (await isBlock(P, x, P.Y, z, 'minecraft:oak_sapling')) n++;
    return ok(n === 2, `${r} | saplings in world=${n}`);
  },

  async farm(ctx, P) {
    await P.cmd(`fill ${P.X - 3} ${P.Y - 1} ${P.Z - 3} ${P.X + 3} ${P.Y - 1} ${P.Z + 3} minecraft:dirt`);
    await P.cmd(`setblock ${P.X + 3} ${P.Y - 1} ${P.Z + 3} minecraft:water`);
    await P.give('wooden_hoe', 1);
    await P.give('wheat_seeds', 4);
    await P.sleep(800);
    const t = await farmSkill(ctx, { action: 'till', crop: 'wheat' });
    const p = await farmSkill(ctx, { action: 'plant', crop: 'wheat' });
    let n = 0;
    for (let x = P.X - 3; x <= P.X + 3; x++) for (let z = P.Z - 3; z <= P.Z + 3; z++) if (await isBlock(P, x, P.Y, z, 'minecraft:wheat')) n++;
    return ok(n >= 2, `till: ${t} | plant: ${p} | wheat planted=${n}`);
  },

  async logs_not_house(ctx, P) {
    const { X, Y, Z } = P;
    // a tree (4 logs + leaves) and a "house wall" of logs framed by planks
    await P.cmd(`fill ${X + 4} ${Y - 1} ${Z - 1} ${X + 4} ${Y - 1} ${Z - 1} minecraft:dirt`);
    await P.cmd(`fill ${X + 4} ${Y} ${Z - 1} ${X + 4} ${Y + 3} ${Z - 1} minecraft:oak_log`);
    await P.cmd(`fill ${X + 3} ${Y + 4} ${Z - 2} ${X + 5} ${Y + 5} ${Z} minecraft:oak_leaves[persistent=true]`);
    await P.cmd(`fill ${X - 5} ${Y} ${Z - 2} ${X - 5} ${Y + 2} ${Z + 2} minecraft:oak_planks`);
    await P.cmd(`fill ${X - 5} ${Y} ${Z} ${X - 5} ${Y + 2} ${Z} minecraft:oak_log`);
    await P.give('stone_axe', 1);
    await P.sleep(800);
    const r = await gatherSkill(ctx, { block: 'log', count: 3 });
    let houseLogs = 0;
    for (let y = P.Y; y <= P.Y + 2; y++) if (await isBlock(P, X - 5, y, Z, 'minecraft:oak_log')) houseLogs++;
    const got = await count(P, 'oak_log');
    return ok(got >= 3 && houseLogs === 3, `${r} | logs gathered=${got}, house logs left=${houseLogs}/3`);
  },

  async gather_remembered(ctx, P) {
    const { X, Y, Z } = P;
    const TX = X + 80;
    await P.cmd(`forceload add ${X} ${Z - 8} ${X + 96} ${Z + 8}`);
    await P.cmd(`fill ${X} ${Y - 2} ${Z - 2} ${X + 88} ${Y - 1} ${Z + 2} minecraft:stone`);
    await P.cmd(`fill ${X} ${Y + 7} ${Z - 2} ${X + 88} ${Y + 7} ${Z + 2} minecraft:light[level=15]`);
    await P.cmd(`setblock ${TX} ${Y - 1} ${Z} minecraft:dirt`);
    await P.cmd(`fill ${TX} ${Y} ${Z} ${TX} ${Y + 3} ${Z} minecraft:oak_log`);
    await P.cmd(`fill ${TX - 1} ${Y + 4} ${Z - 1} ${TX + 1} ${Y + 5} ${Z + 1} minecraft:oak_leaves[persistent=true]`);
    ctx.memory.discover('trees', { x: TX, y: Y, z: Z });
    await P.give('stone_axe', 1);
    await P.sleep(1000);
    const r = await gatherSkill(ctx, { block: 'log', count: 2 });
    const got = await count(P, 'oak_log');
    await P.cmd(`fill ${X} ${Y - 2} ${Z - 2} ${X + 88} ${Y + 7} ${Z + 2} minecraft:air`);
    await P.cmd(`forceload remove ${X} ${Z - 8} ${X + 96} ${Z + 8}`);
    return ok(got >= 2 && /walked to trees/.test(r), `${r} | oak_log=${got}`);
  },

  async go_surface(ctx, P) {
    const { X, Y, Z } = P;
    // bot sealed in a stone block: 9x9 wide, roof 8 blocks up, small air pocket around it
    await P.cmd(`fill ${X - 4} ${Y} ${Z - 4} ${X + 4} ${Y + 8} ${Z + 4} minecraft:stone`);
    await P.cmd(`fill ${X - 1} ${Y} ${Z - 1} ${X + 1} ${Y + 2} ${Z + 1} minecraft:air`);
    await P.give('stone_pickaxe', 1);
    // the client only gets fresh light data for the RCON-filled area after reloading the chunks
    await P.cmd(`tp ${P.botName} ${X + 600} ${Y + 20} ${Z}`);
    await P.sleep(3000);
    await P.cmd(`tp ${P.botName} ${X + 0.5} ${Y} ${Z + 0.5}`);
    await P.sleep(4000);
    const before = ctx.bot.blockAt(ctx.bot.entity.position.offset(0, 1.6, 0))?.skyLight;
    const r = await goSurfaceSkill(ctx);
    const after = ctx.bot.blockAt(ctx.bot.entity.position.offset(0, 1.6, 0))?.skyLight;
    return ok(after >= 13, `${r} | sky light ${before} -> ${after}`);
  },

  async ore_bonus(ctx, P) {
    await P.cmd(`fill ${P.X + 2} ${P.Y} ${P.Z - 1} ${P.X + 3} ${P.Y + 1} ${P.Z + 1} minecraft:stone`);
    await P.cmd(`setblock ${P.X + 4} ${P.Y} ${P.Z} minecraft:iron_ore`);
    await P.give('stone_pickaxe', 1);
    await P.sleep(800);
    const r = await gatherSkill(ctx, { block: 'stone', count: 3 });
    await P.sleep(1500);
    const iron = await count(P, 'raw_iron');
    const cobble = await count(P, 'cobblestone');
    return ok(iron >= 1 && cobble >= 3, `${r} | raw_iron=${iron} cobblestone=${cobble}`);
  },
};
