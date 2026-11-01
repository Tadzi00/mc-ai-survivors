// TRIALS: a fresh full bot with the REAL model gets materials and a plain-language task on the test platform
// (x≈3000, y=200), works on its own for a few minutes, then the result is checked on the server and its
// decisions are printed. Not pass/fail unit tests: they show what the bots can do and where they struggle.
// Usage (repo root, after `npm run build`, with .env loaded): node scripts/trial.mjs [trial...]
process.env.OLLAMA_BASE_URL = process.env.OLLAMA_LOCAL_URL ?? 'http://localhost:11434'; // .env has the Docker name
import { loadConfig } from '../dist/config.js';
import { RconClient } from '../dist/rcon/rcon.js';
import { SeasonsApi } from '../dist/rcon/server.js';
import { BotAgent } from '../dist/bot/agent.js';
import { HomeRegistry, ProtectedAreas, Roster } from '../dist/bot/chat.js';
import { LLMRegistry } from '../dist/llm/factory.js';
import { Village } from '../dist/bot/village.js';
import { scanRoom, isKeepClear } from '../dist/skills/roomPlan.js';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import mineflayer from 'mineflayer';

const config = loadConfig();
config.paths = { ...config.paths, state: './state/trial', logs: './logs/trial' };
config.bot = { ...config.bot, nightShelter: false };
const rcon = new RconClient(config.rcon);
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const cmd = async (c) => strip(await rcon.send(c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const X = 3000, Y = 200, Z = 3000, R = 24;
const llm = new LLMRegistry(config);

async function clearArea() {
  for (let y = Y - 5; y <= Y + 8; y += 4) await cmd(`fill ${X - R} ${y} ${Z - R} ${X + R} ${Math.min(y + 3, Y + 8)} ${Z + R} minecraft:air`);
}
async function platform() {
  await cmd(`forceload add ${X - R - 4} ${Z - R - 4} ${X + R + 4} ${Z + R + 4}`);
  await clearArea();
  await cmd(`fill ${X - R} ${Y - 5} ${Z - R} ${X + R} ${Y - 5} ${Z + R} minecraft:bedrock`);
  await cmd(`fill ${X - R} ${Y - 4} ${Z - R} ${X + R} ${Y - 2} ${Z + R} minecraft:stone`);
  await cmd(`fill ${X - R} ${Y - 1} ${Z - R} ${X + R} ${Y - 1} ${Z + R} minecraft:grass_block`);
  await cmd(`fill ${X - R} ${Y + 7} ${Z - R} ${X + R} ${Y + 7} ${Z + R} minecraft:light[level=15]`);
  // barrier fence round the edge: wandering off a 136-block-high platform is a test artefact, not a lesson
  for (const [x0, z0, x1, z1] of [[X - R, Z - R, X + R, Z - R], [X - R, Z + R, X + R, Z + R], [X - R, Z - R, X - R, Z + R], [X + R, Z - R, X + R, Z + R]]) {
    await cmd(`fill ${x0} ${Y} ${z0} ${x1} ${Y + 6} ${z1} minecraft:barrier`);
  }
  await cmd(`kill @e[type=!player,x=${X - R},y=${Y - 3},z=${Z - R},dx=${2 * R},dy=14,dz=${2 * R}]`);
}
async function cleanup() {
  await cmd(`kill @e[type=!player,x=${X - R},y=${Y - 3},z=${Z - R},dx=${2 * R},dy=14,dz=${2 * R}]`);
  await clearArea();
  await cmd(`forceload remove ${X - R - 4} ${Z - R - 4} ${X + R + 4} ${Z + R + 4}`);
}

async function startAgent(name) {
  rmSync(`./state/trial/bots/${name}.json`, { force: true });
  rmSync(`./logs/trial/${name}.jsonl`, { force: true });
  rmSync('./state/trial/village.json', { force: true });
  const village = new Village('./state/trial');
  const deps = { config, llm, seasons: new SeasonsApi(rcon), roster: new Roster(), rcon, protectedAreas: new ProtectedAreas(), homes: new HomeRegistry(), village };
  await cmd(`whitelist add ${name}`);
  let spawned;
  const ready = new Promise((r) => (spawned = r));
  const a = new BotAgent(name, 'smart', deps, { onSpawn: () => spawned(), onDeath: (ag) => ag.stop(), onDisconnect: () => {} }, null);
  a.start();
  await Promise.race([ready, sleep(20_000)]);
  await cmd(`clear ${name}`);
  await cmd(`effect clear ${name}`);
  await cmd(`effect give ${name} minecraft:saturation 600 1 true`);
  await cmd(`tp ${name} ${X + 0.5} ${Y} ${Z + 0.5}`);
  await sleep(1500);
  return { a, village };
}

/** Runs until `done()` is truthy or the time is up; returns seconds used. */
async function workFor(maxS, done) {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < maxS) {
    await sleep(5000);
    if (await done()) break;
  }
  return Math.round((Date.now() - t0) / 1000);
}

function story(name) {
  const f = `./logs/trial/${name}.jsonl`;
  if (!existsSync(f)) return ['(no log)'];
  const out = [];
  for (const line of readFileSync(f, 'utf8').trim().split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.event === 'skill') out.push(`  ${e.skill} ${JSON.stringify(e.args)} => ${String(e.result).slice(0, 170)}`);
    else if (e.event === 'decision' && !e.ok) out.push(`  [bad reply] ${e.error}`);
    else if (e.event === 'said') out.push(`  says: ${e.text}`);
    else if (e.event === 'dig_refused') out.push(`  [dig refused] ${e.block} ${e.why}`);
  }
  return out;
}

/** What the bot built around its position: room, beds, torches, door, doorway clear. */
function inspect(bot) {
  const beds = bot.findBlocks({ matching: (b) => b.name.endsWith('_bed'), maxDistance: 16, count: 20 }).filter((p) => bot.blockAt(p).getProperties().part === 'foot');
  const torches = bot.findBlocks({ matching: (b) => /torch/.test(b.name), maxDistance: 16, count: 20 });
  const doors = bot.findBlocks({ matching: (b) => b.name.endsWith('_door'), maxDistance: 16, count: 20 }).filter((p) => bot.blockAt(p).getProperties().half === 'lower');
  const blocked = [...beds, ...bot.findBlocks({ matching: (b) => /crafting_table|chest|furnace/.test(b.name), maxDistance: 16, count: 20 })].filter((p) => isKeepClear(bot, p));
  return { beds, torches, doors, blocked };
}

async function roomAt(p) {
  const r = await cmd(`room raw ${p.x} ${p.y} ${p.z}`);
  try { return JSON.parse(r.split('|').pop()); } catch { return undefined; }
}


/** A plain player that asks bots things privately and records their whispered answers. */
async function startAsker() {
  await cmd('whitelist add TestAsker');
  const p = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'TestAsker', auth: 'offline', version: '1.21.4', hideErrors: true });
  const heard = [];
  p.on('whisper', (from, msg) => heard.push({ from, msg: String(msg), at: Date.now() }));
  await new Promise((r) => p.once('spawn', r));
  await cmd('gamemode spectator TestAsker');
  await cmd(`tp TestAsker ${X} ${Y + 4} ${Z}`);
  return { p, heard, ask: (to, text) => p.chat(`/msg ${to} ${text}`), stop: async () => { p.quit(); await cmd('whitelist remove TestAsker'); } };
}

/** Text of the first written book in a player's inventory (via the server). */
async function bookText(name) {
  const out = await cmd(`data get entity ${name} Inventory`);
  const i = out.indexOf('written_book');
  if (i < 0) return undefined;
  // the item compound is {count: 1, Slot: 3b, id: "minecraft:written_book", ...}: take the Slot just before
  const before = [...out.slice(0, i).matchAll(/Slot: (\d+)b/g)].pop();
  const m = before;
  const pages = [...out.slice(i, i + 3000).matchAll(/raw: "((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
  return { slot: m ? Number(m[1]) : undefined, text: pages.join(' | ') || out.slice(i, i + 400) };
}

/** Second, fresh bot that gets the knowledge and is asked about it. */
async function askFresh(name, question, setup, waitS = 150) {
  const { a } = await startAgent(name);
  await setup(name);
  await sleep(1500);
  const asker = await startAsker();
  asker.ask(name, question);
  const t0 = Date.now();
  let answer = '';
  while ((Date.now() - t0) / 1000 < waitS) {
    await sleep(3000);
    const mine = asker.heard.filter((h) => h.from === name).map((h) => h.msg);
    answer = mine.join(' / ');
    if (/-?64|16/.test(answer)) break;
  }
  await asker.stop();
  a.stop();
  await cmd(`whitelist remove ${name}`);
  return answer;
}

const trials = {
  /** Materials for a shelter, two beds and torches; plain-language order. */
  async shelter_beds() {
    const name = 'TestT_beds';
    const { a } = await startAgent(name);
    for (const g of ['cobblestone 128', 'oak_planks 24', 'white_wool 6', 'torch 4', 'stone_pickaxe 1']) await cmd(`give ${name} minecraft:${g}`);
    await sleep(1000);
    await cmd(`tell ${name} please build a shelter here and put two beds and a torch inside it`);
    let res;
    const used = await workFor(420, async () => {
      const bot = a.bot;
      if (!bot?.entity) return false;
      res = inspect(bot);
      if (res.beds.length < 2) return false;
      const room = await roomAt(res.beds[0]);
      res.room = room;
      return room?.sealed && res.torches.length > 0;
    });
    const bot = a.bot;
    if (bot?.entity) {
      res = inspect(bot);
      if (res.beds[0]) res.room = await roomAt(res.beds[0]);
      const sc = scanRoom(bot, bot.entity.position.floored());
      res.plan = sc ? `${sc.cells.length} floor cells, ${sc.doors.length} door(s)` : 'bot not inside a room';
    }
    a.stop();
    await cmd(`whitelist remove ${name}`);
    const ok = res && res.beds.length >= 2 && res.room?.sealed && res.torches.length > 0 && res.blocked.length === 0;
    return { ok, used, why: `beds=${res?.beds.length} torches=${res?.torches.length} doors=${res?.doors.length} doorway blocked by ${res?.blocked.length} | room ${JSON.stringify(res?.room ?? {}).slice(0, 120)} | ${res?.plan}`, name };
  },

  /** Write knowledge into a book; a fresh bot gets that book and is asked about it. */
  async book() {
    const name = 'TestT_writer';
    const { a } = await startAgent(name);
    await cmd(`give ${name} minecraft:writable_book 1`);
    await sleep(1000);
    await cmd(`tell ${name} write in a book that diamonds are found from Y = -64 to Y = 16`);
    let book;
    const used = await workFor(180, async () => (book = await bookText(name))?.text?.length > 0);
    a.stop();
    await cmd(`whitelist remove ${name}`);
    const wrote = !!book && /-?64/.test(book.text) && /16/.test(book.text);
    // reader gets THAT book
    const reader = 'TestT_reader';
    // the writer has left by now: give the reader a copy of exactly what it wrote
    const pageText = (/raw: '\\?"((?:[^'\\]|\\.)*?)\\?"'/.exec(book?.text ?? '')?.[1] ?? '').replace(/\\"/g, '"');
    const answer = pageText
      ? await askFresh(reader, 'on what level can you find diamonds?', async (n) => {
          const r = await cmd(`give ${n} written_book[written_book_content={title:"Notes",author:"${name}",pages:['${JSON.stringify(pageText).replace(/'/g, "\\'")}']}]`);
          console.log('  gave the book:', r.slice(0, 80), '| text:', pageText);
        })
      : '(no book to give)';
    const readIt = story(reader).some((l) => /read_book/.test(l));
    const ok = wrote && /-?64/.test(answer) && /16/.test(answer);
    console.log(`  [reader story]\n${story(reader).join('\n')}`);
    return { ok, used, why: `book: ${book ? JSON.stringify(book.text).slice(0, 160) : 'none'} | reader read_book=${readIt} | answer: ${answer.slice(0, 200)}`, name };
  },

  /** Write it on a sign; a fresh bot next to the sign is asked about it. */
  async sign() {
    const name = 'TestT_signer';
    const { a } = await startAgent(name);
    await cmd(`give ${name} minecraft:oak_sign 2`);
    await sleep(1000);
    await cmd(`tell ${name} put up a sign that says diamonds are found from Y = -64 to Y = 16`);
    let signText = '';
    let signPos;
    const used = await workFor(150, async () => {
      const bot = a.bot;
      if (!bot?.entity) return false;
      const signs = bot.findBlocks({ matching: (b) => b.name.endsWith('_sign'), maxDistance: 8, count: 4 });
      signText = signs.map((p) => JSON.stringify(bot.blockAt(p)?.getSignText?.() ?? '')).join(' ');
      if (signs[0]) signPos = signs[0];
      return signs.length > 0;
    });
    a.stop();
    await cmd(`whitelist remove ${name}`);
    const answer = await askFresh('TestT_reader2', 'on what level can you find diamonds?', async (n) => {
      if (signPos) await cmd(`tp ${n} ${signPos.x + 2.5} ${Y} ${signPos.z + 0.5}`); // walks past the sign
    });
    const readIt = story('TestT_reader2').some((l) => /read_signs/.test(l));
    console.log(`  [reader story]\n${story('TestT_reader2').join('\n')}`);
    const ok = /-?64/.test(signText) && /-?64/.test(answer) && /16/.test(answer);
    return { ok, used, why: `sign: ${signText.slice(0, 160)} | reader read_signs=${readIt} | answer: ${answer.slice(0, 200)}`, name };
  },

  /** The elder names a newborn with the real model (5 tries: never a used name). */
  async naming() {
    const name = 'TestT_elder';
    const { a } = await startAgent(name);
    a.memory.learn('DEATH: Surv_Kira was slain by Zombie near 10 64 10');
    const dead = [{ name: 'Surv_Kira', cause: 'Surv_Kira was slain by Zombie' }, { name: 'Surv_Marek', cause: 'Surv_Marek drowned' }, { name: 'Surv_71', cause: 'fell' }];
    const used = new Set(['Surv_Kira', 'Surv_Marek', 'Surv_71', 'Surv_79']);
    const names = [];
    for (let i = 0; i < 5; i++) {
      const r = await a.proposeName(dead, used);
      names.push(r ? `${r.name} (${r.why})` : 'none');
      if (r) used.add(r.name);
    }
    a.stop();
    await cmd(`whitelist remove ${name}`);
    const okNames = names.filter((n) => n !== 'none');
    return { ok: okNames.length >= 4, used: 0, why: names.join(' | '), name };
  },

  /** Raw iron in a chest; smelt it. */
  async chest_smelt() {
    const name = 'TestT_smelt';
    const { a } = await startAgent(name);
    await cmd(`setblock ${X + 3} ${Y} ${Z} minecraft:chest{Items:[{Slot:0b,id:"minecraft:raw_iron",count:5},{Slot:1b,id:"minecraft:coal",count:4}]}`);
    // 8 cobblestone make the furnace, 4 planks the crafting table it is made on (no trees on the platform)
    await cmd(`give ${name} minecraft:cobblestone 16`);
    await cmd(`give ${name} minecraft:oak_planks 4`);
    await sleep(1000);
    await cmd(`tell ${name} there is raw iron and coal in the chest next to you, take them and smelt the iron into ingots`);
    let ingots = 0;
    const used = await workFor(300, async () => {
      ingots = Number(/Found (\d+)/.exec(await cmd(`clear ${name} minecraft:iron_ingot 0`))?.[1] ?? 0);
      return ingots >= 5;
    });
    a.stop();
    await cmd(`whitelist remove ${name}`);
    return { ok: ingots >= 5, used, why: `iron_ingot=${ingots}`, name };
  },

  /** Logs and cobblestone: make stone tools. */
  async tools() {
    const name = 'TestT_tools';
    const { a } = await startAgent(name);
    await cmd(`give ${name} minecraft:oak_log 6`);
    await cmd(`give ${name} minecraft:cobblestone 10`);
    await sleep(1000);
    await cmd(`tell ${name} make yourself a stone pickaxe, a stone sword and a stone axe`);
    let got = {};
    const used = await workFor(300, async () => {
      for (const t of ['stone_pickaxe', 'stone_sword', 'stone_axe']) got[t] = Number(/Found (\d+)/.exec(await cmd(`clear ${name} minecraft:${t} 0`))?.[1] ?? 0);
      return Object.values(got).every((n) => n > 0);
    });
    a.stop();
    await cmd(`whitelist remove ${name}`);
    return { ok: Object.values(got).every((n) => n > 0), used, why: JSON.stringify(got), name };
  },

  /** A village with one building exists; build another one with a bed for a newcomer. */
  async village_second() {
    const name = 'TestT_vill';
    const { a, village } = await startAgent(name);
    await cmd(`fill ${X - 2} ${Y - 1} ${Z - 2} ${X + 2} ${Y + 3} ${Z + 2} minecraft:cobblestone hollow`);
    await cmd(`setblock ${X} ${Y} ${Z + 2} minecraft:oak_door[half=lower,facing=south]`);
    await cmd(`setblock ${X} ${Y + 1} ${Z + 2} minecraft:oak_door[half=upper,facing=south]`);
    await cmd(`setblock ${X - 1} ${Y} ${Z - 1} minecraft:torch`);
    village.addBuilding({ x0: X - 2, z0: Z - 2, x1: X + 2, z1: Z + 2, y0: Y, door: { x: X, y: Y, z: Z + 2 }, owner: 'Elder' });
    await cmd(`tp ${name} ${X + 0.5} ${Y} ${Z + 8.5}`);
    for (const g of ['cobblestone 128', 'oak_planks 24', 'white_wool 3', 'torch 2']) await cmd(`give ${name} minecraft:${g}`);
    await sleep(1000);
    await cmd(`tell ${name} a new friend is coming, build them a house in the village with a bed`);
    let res = {};
    const used = await workFor(420, async () => {
      const b = village.data.buildings;
      res.buildings = b.length;
      const bot = a.bot;
      if (!bot?.entity) return false;
      res.beds = inspect(bot).beds.length;
      return b.length >= 2 && res.beds >= 1;
    });
    const b2 = village.data.buildings[1];
    a.stop();
    await cmd(`whitelist remove ${name}`);
    const beside = !!b2 && (b2.x0 === X + 5 || b2.x1 === X - 5 || b2.z0 === Z + 5 || b2.z1 === Z - 5);
    return { ok: res.buildings >= 2 && res.beds >= 1 && beside, used, why: `buildings=${res.buildings} beside=${beside} beds=${res.beds}`, name };
  },
};

const wanted = process.argv.slice(2);
for (const [tname, fn] of Object.entries(trials).filter(([n]) => !wanted.length || wanted.includes(n))) {
  await platform();
  let r;
  try {
    r = await fn();
  } catch (e) {
    r = { ok: false, why: 'threw: ' + (e?.stack ?? e).toString().split('\n').slice(0, 3).join(' | ') };
  }
  console.log(`\n=== ${r.ok ? 'DONE' : 'NOT DONE'} ${tname} (${r.used ?? '?'}s): ${r.why}`);
  if (r.name) for (const l of story(r.name)) console.log(l);
  await cleanup();
}
await rcon.close();
process.exit(0);
