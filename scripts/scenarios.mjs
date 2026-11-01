// Scenarios for scripts/harness.mjs. Each gets (ctx, P) with P = { X, Y, Z, cmd, sleep, give, botName } and
// returns { ok, why }. The bot stands at (X, Y, Z) on a stone platform at Y-1. Check results via P.cmd (RCON).
import { writeSignSkill, readSignsSkill, writeBookSkill, readBookSkill } from '../dist/skills/impl/knowledge.js';
import { smeltSkill, gatherSkill, craftSkill } from '../dist/skills/impl/resources.js';
import { placeBedSkill, addDoorSkill, plantSaplingSkill, placeTorchSkill, heatRoomSkill, buildShelterSkill } from '../dist/skills/impl/building.js';
import { sleepSkill, attackSkill, eatSkill, pickBerries, shearSkill } from '../dist/skills/impl/survival.js';
import { farmSkill } from '../dist/skills/impl/farm.js';
import { gotoSkill, goSurfaceSkill } from '../dist/skills/impl/movement.js';
import { digBunker, emergencyHut, leaveHut } from '../dist/skills/helpers.js';
import { scanRoom, renderRoom } from '../dist/skills/roomPlan.js';
import { placeBlockSkill } from '../dist/skills/impl/building.js';
import { chestStoreSkill, chestTakeSkill } from '../dist/skills/impl/storage.js';

const count = async (P, item) => Number(/Found (\d+)/.exec(await P.cmd(`clear ${P.botName} minecraft:${item} 0`))?.[1] ?? 0);
const isBlock = async (P, x, y, z, block) => /passed/i.test(await P.cmd(`execute if block ${x} ${y} ${z} ${block}`));
const ok = (cond, why) => ({ ok: !!cond, why });

/** Hollow stone room 5x5 (outer) around (X,Y,Z), floor at Y-1, roof at Y+3, with an oak door on the south wall. */
async function room(P, { door = true, facing = 'south' } = {}) {
  const { X, Y, Z } = P;
  await P.cmd(`fill ${X - 2} ${Y - 1} ${Z - 2} ${X + 2} ${Y + 3} ${Z + 2} minecraft:stone hollow`);
  if (door) {
    await P.cmd(`setblock ${X} ${Y} ${Z + 2} minecraft:oak_door[half=lower,facing=${facing}]`);
    await P.cmd(`setblock ${X} ${Y + 1} ${Z + 2} minecraft:oak_door[half=upper,facing=${facing}]`);
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

  // Players say "take the wool": the chest holds white_wool.
  async chest_generic(ctx, P) {
    await P.cmd(`setblock ${P.X + 2} ${P.Y} ${P.Z} minecraft:chest{Items:[{Slot:0b,id:"minecraft:white_wool",count:10}]}`);
    await P.sleep(1000);
    const r = await chestTakeSkill(ctx, { items: ['wool:3'] });
    const have = await count(P, 'white_wool');
    return ok(have === 3, `take: ${r} | white_wool=${have}`);
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

  async craft_bed(ctx, P) {
    await P.give('black_wool', 3);
    await P.give('oak_planks', 7);
    await P.sleep(800);
    const r = await craftSkill(ctx, { item: 'white_bed', count: 1 });
    const beds = await count(P, 'black_bed');
    return ok(beds === 1, `${r} | black_bed=${beds}`);
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

  // A door placed sideways (facing east in a south wall) is walkable while closed; opening it blocks the way.
  async door_sideways(ctx, P) {
    await room(P, { facing: 'east' });
    ctx.memory.setPlace('home', { x: P.X, y: P.Y, z: P.Z });
    const out = await gotoSkill(ctx, { x: P.X, y: P.Y, z: P.Z + 7 });
    const outPos = ctx.bot.entity.position.clone();
    const back = await gotoSkill(ctx, { place: 'home' });
    const pos = ctx.bot.entity.position;
    let holes = 0;
    for (let x = P.X - 2; x <= P.X + 2; x++) for (let y = P.Y; y <= P.Y + 2; y++) for (const z of [P.Z - 2, P.Z + 2]) {
      if (x === P.X && z === P.Z + 2 && y <= P.Y + 1) continue;
      if (await isBlock(P, x, y, z, 'minecraft:air')) holes++;
    }
    const inside = Math.abs(pos.x - (P.X + 0.5)) < 2 && Math.abs(pos.z - (P.Z + 0.5)) < 2;
    const door = await isBlock(P, P.X, P.Y, P.Z + 2, '#minecraft:doors');
    return ok(outPos.z > P.Z + 4 && inside && holes === 0 && door, `out: ${out} (z=${outPos.z.toFixed(1)}) | back: ${back} | inside=${inside} holes=${holes} door=${door}`);
  },

  // Coming home from the far side of the house (door on the other wall): walk round to the door, no digging.
  async door_in_far(ctx, P) {
    await room(P);
    ctx.memory.setPlace('home', { x: P.X, y: P.Y, z: P.Z });
    await P.cmd(`tp ${P.botName} ${P.X + 0.5} ${P.Y} ${P.Z - 9.5}`);
    await P.sleep(1500);
    const r = await gotoSkill(ctx, { place: 'home' });
    const pos = ctx.bot.entity.position;
    const inside = Math.abs(pos.x - (P.X + 0.5)) < 2 && Math.abs(pos.z - (P.Z + 0.5)) < 2;
    let holes = 0;
    for (let x = P.X - 2; x <= P.X + 2; x++) for (let y = P.Y; y <= P.Y + 3; y++) for (let z = P.Z - 2; z <= P.Z + 2; z++) {
      const wall = x === P.X - 2 || x === P.X + 2 || z === P.Z - 2 || z === P.Z + 2 || y === P.Y + 3;
      if (!wall || (x === P.X && z === P.Z + 2 && y <= P.Y + 1)) continue;
      if (await isBlock(P, x, y, z, 'minecraft:air')) holes++;
    }
    return ok(inside && holes === 0, `goto home: ${r} | at ${pos.x.toFixed(1)},${pos.z.toFixed(1)} | inside=${inside} holes=${holes}`);
  },

  // Hunting from inside the house: the cow is outside behind the north wall, the door is in the south wall.
  async hunt_from_home(ctx, P) {
    await room(P);
    ctx.memory.setPlace('home', { x: P.X, y: P.Y, z: P.Z });
    await P.cmd(`summon minecraft:cow ${P.X + 0.5} ${P.Y} ${P.Z - 6.5} {NoAI:1b}`);
    await P.give('stone_sword', 1);
    await P.sleep(1500);
    const r = await attackSkill(ctx, { target: 'cow' });
    let holes = 0;
    for (let x = P.X - 2; x <= P.X + 2; x++) for (let y = P.Y; y <= P.Y + 3; y++) for (let z = P.Z - 2; z <= P.Z + 2; z++) {
      const wall = x === P.X - 2 || x === P.X + 2 || z === P.Z - 2 || z === P.Z + 2 || y === P.Y + 3;
      if (!wall || (x === P.X && z === P.Z + 2 && y <= P.Y + 1)) continue;
      if (await isBlock(P, x, y, z, 'minecraft:air')) holes++;
    }
    const beef = await count(P, 'beef');
    return ok(beef > 0 && holes === 0, `attack: ${r} | beef=${beef} holes=${holes}`);
  },

  async room_plan(ctx, P) {
    await room(P);
    await P.cmd(`setblock ${P.X - 1} ${P.Y} ${P.Z - 1} minecraft:chest`);
    await P.sleep(800);
    const r = scanRoom(ctx.bot, ctx.bot.entity.position.floored());
    const plan = r ? renderRoom(ctx.bot, r) : 'no room';
    ctx.log(plan);
    const okPlan = !!r && r.cells.length === 9 && r.doors.length === 1 && /D/.test(plan) && /\+/.test(plan) && /@/.test(plan) && /C/.test(plan);
    return ok(okPlan, `cells=${r?.cells.length} doors=${r?.doors.length}\n${plan}`);
  },

  // Bot stands right inside the door; a crafting table must not end up in the doorway.
  async table_not_in_doorway(ctx, P) {
    await room(P);
    await P.cmd(`tp ${P.botName} ${P.X + 0.5} ${P.Y} ${P.Z + 1.5}`);
    await P.give('crafting_table', 1);
    await P.sleep(1200);
    const r = await placeBlockSkill(ctx, { block: 'crafting_table' });
    const inDoorway = await isBlock(P, P.X, P.Y, P.Z + 1, 'minecraft:crafting_table');
    return ok(/placed/.test(r) && !inDoorway, `${r} | in doorway=${inDoorway}`);
  },

  async bed_not_in_doorway(ctx, P) {
    await room(P);
    await P.cmd(`tp ${P.botName} ${P.X + 0.5} ${P.Y} ${P.Z + 1.5}`);
    await P.give('white_bed', 1);
    await P.sleep(1200);
    const r = await placeBedSkill(ctx);
    const inDoorway = await isBlock(P, P.X, P.Y, P.Z + 1, '#minecraft:beds');
    const placed = /placed/.test(r);
    return ok(placed && !inDoorway, `${r} | in doorway=${inDoorway}`);
  },

  // Two beds must fit in a 3x3 room with the door in the middle of a wall.
  async two_beds(ctx, P) {
    await room(P);
    ctx.memory.setPlace('home', { x: P.X, y: P.Y, z: P.Z });
    await P.give('white_bed', 2);
    await P.sleep(1200);
    const r1 = await placeBedSkill(ctx);
    const r2 = await placeBedSkill(ctx);
    const doorway = await isBlock(P, P.X, P.Y, P.Z + 1, '#minecraft:beds');
    return ok(/placed/.test(r1) && /placed/.test(r2) && !doorway, `${r1} | ${r2} | doorway blocked=${doorway}`);
  },

  // The bot's own shelter, then two beds (what the shelter_beds trial does, without the model).
  async shelter_two_beds(ctx, P) {
    await P.give('cobblestone', 128);
    await P.give('oak_planks', 24);
    await P.give('white_bed', 2);
    await P.give('torch', 4);
    await P.sleep(1200);
    const r0 = await buildShelterSkill(ctx, { size: 5 });
    const r1 = await placeBedSkill(ctx);
    const r2 = await placeBedSkill(ctx);
    const sc = scanRoom(ctx.bot, ctx.bot.entity.position.floored());
    ctx.log(sc ? renderRoom(ctx.bot, sc) : 'no room');
    return ok(/placed/.test(r1) && /placed/.test(r2), `${r0.slice(0, 80)} | ${r1} | ${r2}`);
  },

  // A village with one building: the next shelter goes beside it (path between), even if the bot stands elsewhere.
  async village_build(ctx, P) {
    const { X, Y, Z } = P;
    await room(P);
    ctx.village.addBuilding({ x0: X - 2, z0: Z - 2, x1: X + 2, z1: Z + 2, y0: Y, door: { x: X, y: Y, z: Z + 2 }, owner: 'Other' });
    await P.cmd(`tp ${P.botName} ${X - 9.5} ${Y} ${Z + 9.5}`);
    await P.give('cobblestone', 128);
    await P.give('oak_planks', 12);
    await P.sleep(1500);
    const r = await buildShelterSkill(ctx, { size: 5 });
    const b = ctx.village.data.buildings;
    const nb = b[1];
    const beside = !!nb && (nb.x0 === X + 5 || nb.x1 === X - 5 || nb.z0 === Z + 5 || nb.z1 === Z - 5);
    return ok(b.length === 2 && beside, `${r.slice(0, 140)} | buildings=${JSON.stringify(b.map((x) => [x.x0, x.z0, x.x1, x.z1]))}`);
  },

  // A lava pool between the bot and its target: walk around it, never along its edge or over it.
  async lava_avoid(ctx, P) {
    const { X, Y, Z } = P;
    await P.cmd(`fill ${X + 3} ${Y - 1} ${Z - 3} ${X + 5} ${Y - 1} ${Z + 3} minecraft:lava`);
    await P.sleep(2500); // lava index refresh
    const r = await gotoSkill(ctx, { x: X + 9, y: Y, z: Z });
    const hp = ctx.bot.health;
    const burning = !!ctx.bot.entity.onFire || /lava/.test(ctx.bot.blockAt(ctx.bot.entity.position)?.name ?? '');
    return ok(/arrived/.test(r) && hp >= 19 && !burning, `${r} | health=${hp} burning=${burning}`);
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

  // A dirt wall (natural, cheap to dig) across the whole platform with a door 7 blocks to the side.
  // Straight through the wall is shorter, but the bot should walk round through the door, leaving no hole.
  async door_detour(ctx, P) {
    const { X, Y, Z } = P;
    const wx = X + 3;
    await P.cmd(`fill ${wx} ${Y} ${Z - 12} ${wx} ${Y + 2} ${Z + 12} minecraft:dirt`);
    await P.cmd(`setblock ${wx} ${Y} ${Z + 7} minecraft:oak_door[half=lower,facing=east]`);
    await P.cmd(`setblock ${wx} ${Y + 1} ${Z + 7} minecraft:oak_door[half=upper,facing=east]`);
    await P.sleep(6000); // man-made index refresh (RCON blocks fire no events)
    ctx.log('doors known: ' + JSON.stringify(ctx.bot.__doorIndex?.doors));
    if (process.env.NODIG) ctx.bot.pathfinder.movements.canDig = false;
    const dbg = process.env.DEBUG_DOORS ? setInterval(() => {
      const d = ctx.bot.blockAt(new ctx.bot.entity.position.constructor(wx, Y, Z + 7));
      ctx.log(`pos ${ctx.bot.entity.position.toString()} door ${JSON.stringify(d?.getProperties())} moving=${ctx.bot.pathfinder.isMoving()}`);
    }, 2000) : null;
    const r = await gotoSkill(ctx, { x: X + 6, y: Y, z: Z }).catch((e) => 'ERR ' + e.message);
    if (dbg) clearInterval(dbg);
    const pos = ctx.bot.entity.position;
    let holes = 0;
    for (let z = Z - 12; z <= Z + 12; z++) for (let y = Y; y <= Y + 2; y++) {
      if (z === Z + 7 && y <= Y + 1) continue;
      if (!(await isBlock(P, wx, y, z, 'minecraft:dirt'))) holes++;
    }
    await P.sleep(1500);
    const closed = await isBlock(P, wx, Y, Z + 7, 'minecraft:oak_door[open=false]');
    return ok(pos.x > wx + 1 && holes === 0 && closed, `goto: ${r} | at x=${pos.x.toFixed(1)} z=${pos.z.toFixed(1)} | holes=${holes} door closed=${closed}`);
  },

  async add_door(ctx, P) {
    await room(P, { door: false });
    ctx.memory.setPlace('home', { x: P.X, y: P.Y, z: P.Z });
    ctx.memory.setPlace('doorway', { x: P.X, y: P.Y, z: P.Z + 2 });
    await P.give('oak_planks', 10); // 6 for the door + 4 for a crafting table
    await P.sleep(800);
    // start off to the side, so a careless placement would face east/west
    await P.cmd(`tp ${P.botName} ${P.X + 1.5} ${P.Y} ${P.Z + 0.5}`);
    await P.sleep(800);
    const r = await addDoorSkill(ctx);
    const door = await isBlock(P, P.X, P.Y, P.Z + 2, '#minecraft:doors');
    const facing = (await isBlock(P, P.X, P.Y, P.Z + 2, '#minecraft:doors[facing=north]')) || (await isBlock(P, P.X, P.Y, P.Z + 2, '#minecraft:doors[facing=south]'));
    return ok(door && facing, `add_door: ${r} | door=${door} facing along passage=${facing}`);
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

  async hunt_low_health(ctx, P) {
    await P.give('stone_sword', 1);
    await P.cmd(`effect give ${P.botName} minecraft:instant_damage 1 1 true`); // 20 -> ~8 hp
    await P.cmd(`effect give ${P.botName} minecraft:instant_damage 1 0 true`); // -> ~2-5 hp
    await P.cmd(`summon minecraft:cow ${P.X + 4} ${P.Y} ${P.Z}`);
    await P.sleep(1500);
    const hp = ctx.bot.health;
    const r = await attackSkill(ctx, { target: 'cow' });
    await P.sleep(2500);
    const beef = await count(P, 'beef');
    return ok(beef > 0, `health ${hp} | attack: ${r} | beef=${beef}`);
  },

  // Asked for a cow where only a pig lives: any food animal will do.
  async hunt_any(ctx, P) {
    await P.cmd(`summon minecraft:pig ${P.X + 6} ${P.Y} ${P.Z + 2}`);
    await P.give('stone_sword', 1);
    await P.sleep(1000);
    const r = await attackSkill(ctx, { target: 'cow' });
    const pork = await count(P, 'porkchop');
    return ok(pork > 0, `attack cow: ${r} | porkchop=${pork}`);
  },

  // "craft cooked_beef" is smelting: it must cook the beef (furnace made from cobblestone).
  async cook_via_craft(ctx, P) {
    await P.give('beef', 3);
    await P.give('cobblestone', 8);
    await P.give('oak_planks', 8);
    await P.give('coal', 2);
    await P.sleep(1000);
    const r = await craftSkill(ctx, { item: 'cooked_cow', count: 3 });
    const cooked = await count(P, 'cooked_beef');
    return ok(cooked === 3, `${r} | cooked_beef=${cooked}`);
  },

  // No animals: ripe sweet berries are picked (right-click), the bushes stay.
  async berries(ctx, P) {
    for (const dz of [-2, 2]) {
      await P.cmd(`setblock ${P.X + 4} ${P.Y - 1} ${P.Z + dz} minecraft:grass_block`);
      await P.cmd(`setblock ${P.X + 4} ${P.Y} ${P.Z + dz} minecraft:sweet_berry_bush[age=3]`);
    }
    await P.sleep(1000);
    const n = await pickBerries(ctx);
    const bushes = (await isBlock(P, P.X + 4, P.Y, P.Z - 2, 'minecraft:sweet_berry_bush')) && (await isBlock(P, P.X + 4, P.Y, P.Z + 2, 'minecraft:sweet_berry_bush'));
    return ok(n >= 2 && bushes, `picked ${n} berries, bushes still there=${bushes}`);
  },

  // Shears from 2 iron, then wool from living sheep.
  async shear(ctx, P) {
    for (const dz of [-3, 3]) await P.cmd(`summon minecraft:sheep ${P.X + 5} ${P.Y} ${P.Z + dz} {NoAI:1b}`);
    await P.give('iron_ingot', 2);
    await P.give('oak_planks', 4);
    await P.sleep(1200);
    const r = await shearSkill(ctx, { count: 2 });
    const wool = await count(P, 'white_wool');
    const alive = /passed/i.test(await P.cmd(`execute if entity @e[type=sheep,x=${P.X - 12},y=${P.Y - 2},z=${P.Z - 12},dx=24,dy=10,dz=24]`));
    return ok(wool >= 2 && alive, `${r} | white_wool=${wool} sheep alive=${alive}`);
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

  // A field by the water: setup makes a hoe and plants; tend harvests ripe wheat, replants, bakes bread.
  async field(ctx, P) {
    const { X, Y, Z } = P;
    const cx = X + 6;
    await P.cmd(`fill ${cx - 4} ${Y - 1} ${Z - 4} ${cx + 4} ${Y - 1} ${Z + 4} minecraft:grass_block`);
    await P.cmd(`setblock ${cx} ${Y - 1} ${Z} minecraft:water`);
    await P.give('wheat_seeds', 10);
    await P.give('oak_planks', 8);
    await P.sleep(1500);
    const r1 = await farmSkill(ctx, { action: 'setup', crop: 'wheat' });
    let planted = 0;
    for (let x = cx - 4; x <= cx + 4; x++) for (let z = Z - 4; z <= Z + 4; z++) if (await isBlock(P, x, Y, z, 'minecraft:wheat')) planted++;
    // make 6 of them ripe
    let made = 0;
    for (let x = cx - 4; x <= cx + 4 && made < 6; x++) for (let z = Z - 4; z <= Z + 4 && made < 6; z++) {
      if (await isBlock(P, x, Y, z, 'minecraft:wheat')) { await P.cmd(`setblock ${x} ${Y} ${z} minecraft:wheat[age=7]`); made++; }
    }
    await P.sleep(1000);
    const r2 = await farmSkill(ctx, { action: 'tend', crop: 'wheat' });
    const bread = await count(P, 'bread');
    let after = 0;
    for (let x = cx - 4; x <= cx + 4; x++) for (let z = Z - 4; z <= Z + 4; z++) if (await isBlock(P, x, Y, z, 'minecraft:wheat')) after++;
    return ok(planted >= 6 && bread >= 1 && after >= planted - 1, `setup: ${r1.slice(0, 90)} | planted=${planted} | tend: ${r2} | bread=${bread} wheat plants after=${after}`);
  },

  // A sandy shore: swap sand for the dirt we carry, till, plant.
  async field_sand(ctx, P) {
    const { X, Y, Z } = P;
    const cx = X + 6;
    await P.cmd(`fill ${cx - 3} ${Y - 1} ${Z - 3} ${cx + 3} ${Y - 1} ${Z + 3} minecraft:sand`);
    await P.cmd(`setblock ${cx} ${Y - 1} ${Z} minecraft:water`);
    await P.give('wheat_seeds', 8);
    await P.give('dirt', 16);
    await P.give('wooden_hoe', 1);
    await P.sleep(1500);
    const r = await farmSkill(ctx, { action: 'setup', crop: 'wheat' });
    let planted = 0;
    for (let x = cx - 3; x <= cx + 3; x++) for (let z = Z - 3; z <= Z + 3; z++) if (await isBlock(P, x, Y, z, 'minecraft:wheat')) planted++;
    return ok(planted >= 6, `${r.slice(0, 120)} | planted=${planted}`);
  },

  // Podzol shore and NO dirt carried: dig the podzol (it drops dirt), put the dirt back, till, plant.
  async field_podzol(ctx, P) {
    const { X, Y, Z } = P;
    const cx = X + 6;
    await P.cmd(`fill ${cx - 3} ${Y - 1} ${Z - 3} ${cx + 3} ${Y - 1} ${Z + 3} minecraft:podzol`);
    await P.cmd(`setblock ${cx} ${Y - 1} ${Z} minecraft:water`);
    await P.give('wheat_seeds', 6);
    await P.give('wooden_hoe', 1);
    await P.sleep(1500);
    const r = await farmSkill(ctx, { action: 'setup', crop: 'wheat' });
    let planted = 0;
    for (let x = cx - 3; x <= cx + 3; x++) for (let z = Z - 3; z <= Z + 3; z++) if (await isBlock(P, x, Y, z, 'minecraft:wheat')) planted++;
    const field = ctx.village.data.field;
    return ok(planted >= 4 && field?.planted > 0, `${r.slice(0, 150)} | planted=${planted} field=${JSON.stringify(field ?? null).slice(0, 60)}`);
  },

  // A field with a single plant (left by a failed setup): tend grows it.
  async field_grow(ctx, P) {
    const { X, Y, Z } = P;
    const cx = X + 6;
    await P.cmd(`fill ${cx - 4} ${Y - 1} ${Z - 4} ${cx + 4} ${Y - 1} ${Z + 4} minecraft:grass_block`);
    await P.cmd(`setblock ${cx} ${Y - 1} ${Z} minecraft:water`);
    await P.cmd(`setblock ${cx + 1} ${Y - 1} ${Z} minecraft:farmland`);
    await P.cmd(`setblock ${cx + 1} ${Y} ${Z} minecraft:wheat`);
    ctx.village.setField({ x: cx, y: Y - 1, z: Z }, 1);
    await P.give('wheat_seeds', 14);
    await P.give('wooden_hoe', 1);
    await P.sleep(1500);
    const r = await farmSkill(ctx, { action: 'tend', crop: 'wheat' });
    let plants = 0;
    for (let x = cx - 4; x <= cx + 4; x++) for (let z = Z - 4; z <= Z + 4; z++) if (await isBlock(P, x, Y, z, 'minecraft:wheat')) plants++;
    return ok(plants >= 10, `${r} | plants=${plants}`);
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

  async bunker(ctx, P) {
    const { X, Y, Z } = P;
    await P.give('dirt', 4);
    await P.give('stone_pickaxe', 1);
    await P.sleep(1000);
    const r = await digBunker(ctx);
    await P.sleep(800);
    const feetY = Math.floor(ctx.bot.entity.position.y);
    const sealed = !(await isBlock(P, X, Y - 1, Z, 'minecraft:air'));
    const out = await goSurfaceSkill(ctx);
    const sky = ctx.bot.blockAt(ctx.bot.entity.position.offset(0, 1.6, 0))?.skyLight;
    return ok(feetY === Y - 3 && sealed && sky >= 13, `${r.why} | feet y=${feetY} (want ${Y - 3}) sealed=${sealed} | morning: ${out} sky=${sky}`);
  },

  async shelter_relocate(ctx, P) {
    const { X, Y, Z } = P;
    await P.cmd(`setblock ${X + 1} ${Y} ${Z} minecraft:oak_planks`); // "something built" inside the outline
    await P.give('cobblestone', 128);
    await P.give('oak_planks', 12);
    await P.give('torch', 6);
    await P.sleep(6000); // RealisticSeasons' outside cache (RCON blocks fire no events)
    const r = await buildShelterSkill(ctx, { size: 5 });
    const p = ctx.bot.entity.position.floored();
    const room = JSON.parse((await P.cmd(`room raw ${p.x} ${p.y} ${p.z}`)).split('|').pop());
    return ok(/moved/.test(r) && room.sealed, `${r.slice(0, 160)} | sealed=${room.sealed}`);
  },

  // No hole possible: wall in with blocks (9), then step out in the morning.
  async emergency_hut(ctx, P) {
    await P.give('dirt', 16);
    await P.sleep(800);
    const r = await emergencyHut(ctx);
    const f = ctx.bot.entity.position.floored();
    let gaps = 0;
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[1,1,0],[-1,1,0],[0,1,1],[0,1,-1],[0,2,0]]) {
      if (await isBlock(P, f.x + dx, f.y + dy, f.z + dz, 'minecraft:air')) gaps++;
    }
    const out = r.feet ? await leaveHut(ctx, r.feet) : 'no hut';
    let open = 0;
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) if (await isBlock(P, f.x + dx, f.y, f.z + dz, 'minecraft:air')) open++;
    ctx.log(`after leaving: open sides at feet=${open} pos=${ctx.bot.entity.position}`);
    const moved = ctx.bot.entity.position.floored().distanceTo(f) >= 1.5;
    return ok(!!r.feet && gaps === 0 && moved, `${r.why} | gaps=${gaps} | ${out} | moved out=${moved}`);
  },

  // The hole cuts into a cave: the open side gets walled before the top is sealed.
  async bunker_cave(ctx, P) {
    const { X, Y, Z } = P;
    await P.cmd(`fill ${X + 1} ${Y - 3} ${Z - 1} ${X + 3} ${Y - 2} ${Z + 1} minecraft:air`); // cave right next to the feet/head cells
    await P.give('dirt', 8);
    await P.sleep(800);
    const r = await digBunker(ctx);
    const wall = (await isBlock(P, X + 1, Y - 3, Z, 'minecraft:dirt')) && (await isBlock(P, X + 1, Y - 2, Z, 'minecraft:dirt'));
    return ok(!!r.feet && wall, `${r.why} | cave side walled=${wall}`);
  },

  // Same cave, no blocks to wall it with: refuse (the night reflex then finds another spot or builds a hut).
  async bunker_cave_noblocks(ctx, P) {
    const { X, Y, Z } = P;
    await P.cmd(`fill ${X + 1} ${Y - 3} ${Z - 1} ${X + 3} ${Y - 2} ${Z + 1} minecraft:air`);
    await P.sleep(800);
    const r = await digBunker(ctx);
    const untouched = await isBlock(P, X, Y - 1, Z, 'minecraft:stone');
    return ok(!r.feet && untouched, `${r.why} | ground untouched=${untouched}`);
  },

  async bunker_not_in_water(ctx, P) {
    const { X, Y, Z } = P;
    await P.cmd(`fill ${X - 2} ${Y} ${Z - 2} ${X + 2} ${Y} ${Z + 2} minecraft:water`);
    await P.give('dirt', 4);
    await P.sleep(1500);
    const r = await digBunker(ctx);
    const floorIntact = !(await isBlock(P, X, Y - 1, Z, 'minecraft:air')) && !(await isBlock(P, X, Y - 1, Z, 'minecraft:water'));
    return ok(!r.feet && /water/.test(r.why) && floorIntact, `${r.why} | floor intact=${floorIntact}`);
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
