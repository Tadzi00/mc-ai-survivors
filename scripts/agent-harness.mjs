// Live AGENT tests: full BotAgents (reflexes, shouts, orders, rescue) on a temporary platform at x≈3000, y=200.
// The model is a stub that always answers "wait", so only scripted behaviour acts and results are repeatable.
// Usage (repo root, after `npm run build`, with .env loaded): node scripts/agent-harness.mjs [scenario...]
import { loadConfig } from '../dist/config.js';
import { RconClient } from '../dist/rcon/rcon.js';
import { SeasonsApi } from '../dist/rcon/server.js';
import { BotAgent } from '../dist/bot/agent.js';
import { HomeRegistry, ProtectedAreas, Roster } from '../dist/bot/chat.js';
import { rmSync } from 'node:fs';
import { Village } from '../dist/bot/village.js';

const config = loadConfig();
config.paths = { ...config.paths, state: './state/agent-test', logs: './logs/agent-test' };
// Scenarios must not depend on the real world's time of day (bots would bunker at night).
config.bot = { ...config.bot, nightShelter: false };
const rcon = new RconClient(config.rcon);
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const cmd = async (c) => strip(await rcon.send(c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const X = 3000, Y = 200, Z = 3000, R = 24;

const stub = {
  complete: async () => ({ text: '{"thought":"test: waiting","skill":"wait","args":{"seconds":5}}' }),
};
const llm = { forTier: () => ({ provider: stub, tier: { model: 'stub', maxTokens: 50, temperature: 0 } }) };

/** /fill refuses more than 32768 blocks: clear the test area in horizontal slices. */
async function clearArea() {
  for (let y = Y - 5; y <= Y + 8; y += 4) {
    const r = await cmd(`fill ${X - R} ${y} ${Z - R} ${X + R} ${Math.min(y + 3, Y + 8)} ${Z + R} minecraft:air`);
    if (/too many|cannot/i.test(r)) console.log('clearArea:', r);
  }
}

async function platform() {
  await cmd(`forceload add ${X - R - 4} ${Z - R - 4} ${X + R + 4} ${Z + R + 4}`);
  await clearArea();
  await cmd(`fill ${X - R} ${Y - 5} ${Z - R} ${X + R} ${Y - 5} ${Z + R} minecraft:bedrock`);
  await cmd(`fill ${X - R} ${Y - 4} ${Z - R} ${X + R} ${Y - 1} ${Z + R} minecraft:stone`);
  // light ceiling: no natural mob spawns on the test platform even at night
  await cmd(`fill ${X - R} ${Y + 7} ${Z - R} ${X + R} ${Y + 7} ${Z + R} minecraft:light[level=15]`);
  await cmd(`kill @e[type=!player,x=${X - R},y=${Y - 3},z=${Z - R},dx=${2 * R},dy=14,dz=${2 * R}]`);
}
async function cleanup() {
  await cmd(`kill @e[type=!player,x=${X - R},y=${Y - 3},z=${Z - R},dx=${2 * R},dy=14,dz=${2 * R}]`);
  await clearArea();
  await cmd(`forceload remove ${X - R - 4} ${Z - R - 4} ${X + R + 4} ${Z + R + 4}`);
}

/** Starts agents, waits for spawn, teleports them to their start spots. */
async function startAgents(specs) {
  rmSync('./state/agent-test/village.json', { force: true });
  const agents = [];
  const deps = { config, llm, seasons: new SeasonsApi(rcon), roster: new Roster(), rcon, protectedAreas: new ProtectedAreas(), homes: new HomeRegistry(), village: new Village('./state/agent-test'), peers: () => agents };
  for (const s of specs) {
    await cmd(`whitelist add ${s.name}`);
    let spawned;
    const ready = new Promise((r) => (spawned = r));
    // On death stop right away: a respawned test bot would wander the real world.
    rmSync(`./state/agent-test/bots/${s.name}.json`, { force: true });
    const a = new BotAgent(s.name, 'smart', deps, { onSpawn: () => spawned(), onDeath: (ag) => ag.stop(), onDisconnect: () => {} }, null);
    a.start();
    await Promise.race([ready, sleep(20_000)]);
    await cmd(`clear ${s.name}`);
    await cmd(`effect clear ${s.name}`);
    await cmd(`tp ${s.name} ${s.x + 0.5} ${Y} ${s.z + 0.5}`);
    agents.push(a);
    await sleep(5500); // join throttle-friendly spacing
  }
  return agents;
}
async function stopAgents(agents) {
  for (const a of agents) {
    a.stop();
    await cmd(`whitelist remove ${a.name}`);
  }
}
const pos = async (name) => {
  const out = await cmd(`data get entity ${name} Pos`);
  const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(out);
  return m ? { x: +m[1], y: +m[2], z: +m[3] } : undefined;
};
const count = async (name, item) => Number(/Found (\d+)/.exec(await cmd(`clear ${name} minecraft:${item} 0`))?.[1] ?? 0);
const alive = async (sel) => /Found|entity/.test(await cmd(`execute if entity ${sel}`)) || /passed/i.test(await cmd(`execute if entity ${sel}`));

const scenarios = {
  /** Armed agent kills a husk (husks don't burn in daylight). */
  async fight() {
    const [a] = await startAgents([{ name: 'TestA_fight', x: X, z: Z }]);
    await cmd(`give TestA_fight minecraft:stone_sword 1`);
    await sleep(1500);
    await cmd(`summon minecraft:husk ${X + 5} ${Y} ${Z}`);
    let dead = false;
    for (let i = 0; i < 40 && !dead; i++) {
      await sleep(1000);
      dead = !/passed/i.test(await cmd(`execute if entity @e[type=husk,x=${X - R},y=${Y - 3},z=${Z - R},dx=${2 * R},dy=14,dz=${2 * R}]`));
    }
    const survived = !a.isDead;
    await stopAgents([a]);
    return { ok: dead && survived, why: `husk killed=${dead}, bot alive=${survived}` };
  },

  /** Low on health in a dead-end corner with a husk in the way out: it must fight back, not run into walls. */
  async cornered() {
    const [a] = await startAgents([{ name: 'TestA_corner', x: X, z: Z }]);
    // dead end: walls west, north and south of a 1-wide corridor; the way out is east (where the husk is)
    await cmd(`fill ${X - 1} ${Y} ${Z - 1} ${X - 1} ${Y + 2} ${Z + 1} minecraft:stone`);
    await cmd(`fill ${X} ${Y} ${Z - 1} ${X + 3} ${Y + 2} ${Z - 1} minecraft:stone`);
    await cmd(`fill ${X} ${Y} ${Z + 1} ${X + 3} ${Y + 2} ${Z + 1} minecraft:stone`);
    await cmd(`give TestA_corner minecraft:stone_sword 1`);
    await sleep(1500);
    await cmd(`damage TestA_corner 13 minecraft:generic`);
    await cmd(`summon minecraft:husk ${X + 2.5} ${Y} ${Z + 0.5}`);
    let dead = false;
    for (let i = 0; i < 45 && !dead && !a.isDead; i++) {
      await sleep(1000);
      dead = !/passed/i.test(await cmd(`execute if entity @e[type=husk,x=${X - R},y=${Y - 3},z=${Z - R},dx=${2 * R},dy=14,dz=${2 * R}]`));
    }
    const survived = !a.isDead;
    await stopAgents([a]);
    return { ok: dead && survived, why: `husk killed=${dead}, bot alive=${survived}` };
  },

  /** A teammate with spare food walks over and gives some to a hungry bot that has none. */
  async share_food() {
    const [a, b] = await startAgents([
      { name: 'TestA_share', x: X, z: Z },
      { name: 'TestB_share', x: X + 12, z: Z },
    ]);
    await cmd('give TestA_share minecraft:cooked_beef 8');
    await cmd('effect give TestB_share minecraft:hunger 4 255');
    await sleep(5000);
    // the hungry bot may eat it straight away: count what it holds plus what it ate (food level rose)
    const hunger0 = Number(/(\d+)$/.exec(await cmd('data get entity TestB_share foodLevel'))?.[1] ?? 0);
    let got = 0, hunger = hunger0;
    for (let i = 0; i < 40 && got === 0 && hunger <= hunger0; i++) {
      await sleep(1000);
      got = Number(/Found (\d+)/.exec(await cmd('clear TestB_share minecraft:cooked_beef 0'))?.[1] ?? 0);
      hunger = Number(/(\d+)$/.exec(await cmd('data get entity TestB_share foodLevel'))?.[1] ?? 0);
    }
    await stopAgents([a, b]);
    return { ok: got > 0 || hunger > hunger0, why: `hungry bot holds ${got} cooked beef, food ${hunger0} -> ${hunger}` };
  },

  /** "Can you give me some food?" -> a teammate hands it over. */
  async ask_give() {
    const [a, b] = await startAgents([
      { name: 'TestA_give', x: X, z: Z },
      { name: 'TestB_give', x: X + 6, z: Z },
    ]);
    await cmd('give TestA_give minecraft:bread 6');
    await sleep(2000);
    b.bot.chat('TestA_give, can you give me some food?');
    let got = 0;
    for (let i = 0; i < 30 && got === 0; i++) {
      await sleep(1000);
      got = Number(/Found (\d+)/.exec(await cmd('clear TestB_give minecraft:bread 0'))?.[1] ?? 0);
    }
    await stopAgents([a, b]);
    return { ok: got > 0, why: `asked for food, received ${got} bread` };
  },

  /** Under a stone ceiling in deep water: swimming straight up hits the stone; it must find the open water. */
  async trapped() {
    const [a] = await startAgents([{ name: 'TestA_trap', x: X, z: Z }]);
    await cmd(`fill ${X - 1} ${Y - 4} ${Z - 1} ${X + 5} ${Y - 1} ${Z + 1} minecraft:water`);
    await cmd(`fill ${X - 1} ${Y - 1} ${Z - 1} ${X + 2} ${Y - 1} ${Z + 1} minecraft:stone`); // ceiling over the west part
    await cmd(`tp TestA_trap ${X + 0.5} ${Y - 4} ${Z + 0.5}`);
    await cmd(`effect clear TestA_trap`);
    let surfaced = false;
    for (let i = 0; i < 45 && !a.isDead && !surfaced; i++) {
      await sleep(1000);
      const p = await pos('TestA_trap');
      surfaced = !!p && p.y >= Y - 1.5 && p.x > X + 2.5;
    }
    const alive = !a.isDead;
    await stopAgents([a]);
    return { ok: alive && surfaced, why: `alive=${alive}, got out from under the ceiling=${surfaced}` };
  },

  /** Starving agent with no food hunts a cow by itself. */
  async starving() {
    const [a] = await startAgents([{ name: 'TestA_food', x: X, z: Z }]);
    await cmd(`effect give TestA_food minecraft:hunger 6 255`);
    await sleep(6500);
    await cmd(`summon minecraft:cow ${X + 6} ${Y} ${Z + 2}`);
    await cmd(`give TestA_food minecraft:wooden_sword 1`);
    let food = 0;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      food = (await count('TestA_food', 'beef')) + (await count('TestA_food', 'cooked_beef'));
      const hunger = Number(/(\d+)$/.exec(await cmd('data get entity TestA_food foodLevel'))?.[1] ?? 0);
      if (food > 0 || hunger > 8) {
        food = Math.max(food, 1);
        break;
      }
    }
    await stopAgents([a]);
    return { ok: food > 0, why: `got/ate beef: ${food > 0}` };
  },

  /** A is attacked and shouts HELP; B (20 blocks away) runs over by reflex. */
  async rescue() {
    const agents = await startAgents([
      { name: 'TestA_help', x: X, z: Z },
      { name: 'TestB_help', x: X + 20, z: Z + 10 },
    ]);
    await cmd(`give TestB_help minecraft:stone_sword 1`);
    await cmd(`give TestA_help minecraft:stone_sword 1`); // armed: stands and fights instead of fleeing off the platform
    await cmd(`effect give TestA_help minecraft:resistance 120 3 true`); // takes hits (-> HELP) but survives
    await sleep(1500);
    await cmd(`summon minecraft:husk ${X + 1} ${Y} ${Z}`);
    let closest = 99;
    for (let i = 0; i < 200; i++) {
      await sleep(250);
      if (agents[0].isDead) break;
      const a = await pos('TestA_help'), b = await pos('TestB_help');
      if (a && b) closest = Math.min(closest, Math.hypot(a.x - b.x, a.z - b.z));
      if (closest < 7) break;
    }
    await stopAgents(agents);
    return { ok: closest < 7, why: `closest B got to A: ${closest.toFixed(1)} blocks` };
  },

  /** B can't reach A (glass box): after 30 s B shouts "are you alive?", A answers, B hears the answer. */
  async checkin() {
    const agents = await startAgents([
      { name: 'TestA_chk', x: X, z: Z },
      { name: 'TestB_chk', x: X + 15, z: Z },
    ]);
    await cmd(`fill ${X + 14} ${Y} ${Z - 1} ${X + 16} ${Y + 2} ${Z + 1} minecraft:glass hollow`);
    await cmd(`effect give TestA_chk minecraft:resistance 120 3 true`);
    await cmd(`effect give TestA_chk minecraft:regeneration 120 2 true`);
    await sleep(1000);
    await cmd(`summon minecraft:husk ${X + 1} ${Y} ${Z}`);
    const read = (n) => import('node:fs').then((fs) => fs.readFileSync(`./logs/agent-test/${n}.jsonl`, 'utf8'));
    let asked = false, answered = false, heardAnswer = false;
    for (let i = 0; i < 90 && !(asked && answered && heardAnswer); i++) {
      await sleep(1000);
      const a = await read('TestA_chk').catch(() => '');
      const b = await read('TestB_chk').catch(() => '');
      asked = b.includes('"event":"help_checkin"');
      answered = a.includes('"event":"alive_reply"');
      heardAnswer = /"from":"TestA_chk","text":"\[SHOUT\] TestB_chk: alive at/.test(b);
    }
    await stopAgents(agents);
    return { ok: asked && answered && heardAnswer, why: `B asked=${asked}, A answered=${answered}, B heard answer=${heardAnswer}` };
  },

  /** Dropped at the bottom of an 8-deep water shaft: must swim up and survive. */
  async drowning() {
    const [a] = await startAgents([{ name: 'TestA_swim', x: X, z: Z }]);
    // 3x3 shaft of water from Y-4 up to Y+3, stone around it, open to the sky above
    await cmd(`fill ${X - 2} ${Y - 4} ${Z - 2} ${X + 2} ${Y + 4} ${Z + 2} minecraft:stone`);
    await cmd(`fill ${X - 1} ${Y - 4} ${Z - 1} ${X + 1} ${Y + 3} ${Z + 1} minecraft:water`);
    await cmd(`fill ${X - 1} ${Y + 4} ${Z - 1} ${X + 1} ${Y + 4} ${Z + 1} minecraft:air`);
    await cmd(`tp TestA_swim ${X + 0.5} ${Y - 4} ${Z + 0.5}`);
    let alive = true;
    let surfaced = false;
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      if (a.isDead) {
        alive = false;
        break;
      }
      const p = await pos('TestA_swim');
      if (p && p.y >= Y + 2.5) surfaced = true;
    }
    await stopAgents([a]);
    return { ok: alive && surfaced, why: `alive=${alive}, reached the surface=${surfaced}` };
  },

  /** A (experienced) mentors newborn B: B must know A's home, chest contents, finds and lessons. */
  async mentor() {
    const [a, b] = await startAgents([
      { name: 'TestA_ment', x: X, z: Z },
      { name: 'TestB_ment', x: X + 3, z: Z },
    ]);
    a.memory.setPlace('home', { x: X, y: Y, z: Z });
    a.memory.setChest({ x: X + 2, y: Y, z: Z }, { iron_ingot: 5, bread: 3 }, 'me');
    a.memory.discover('trees', { x: X + 30, y: Y, z: Z });
    a.memory.learn('gather iron_ore: need a stone pickaxe to mine iron');
    a.mentor(b);
    for (let i = 0; i < 20 && (b.memory.data.lessons ?? []).length === 0; i++) await sleep(1000);
    const m = b.memory.data;
    const village = m.places.village;
    const chest = Object.values(m.storage ?? {})[0];
    const trees = (m.discoveries ?? []).some((d) => d.what === 'trees');
    const lesson = (m.lessons ?? []).some((l) => /stone pickaxe/.test(l));
    await stopAgents([a, b]);
    const ok = !!village && chest?.items?.iron_ingot === 5 && trees && lesson;
    return { ok, why: `village=${!!village} chest=${JSON.stringify(chest?.items)} trees=${trees} lesson=${lesson}` };
  },

  /** Two bots in earshot swap what the other doesn't know (said aloud, stored in memory). */
  async meeting() {
    const [a, b] = await startAgents([
      { name: 'TestA_meet', x: X, z: Z },
      { name: 'TestB_meet', x: X + 6, z: Z },
    ]);
    a.memory.discover('iron_ore', { x: X + 40, y: Y - 20, z: Z });
    a.memory.learn('gather iron_ore: need a stone pickaxe to mine iron');
    b.memory.discover('cows', { x: X - 30, y: Y, z: Z + 10 });
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) {
      await sleep(1000);
      const bi = (b.memory.data.discoveries ?? []).some((d) => d.what === 'iron_ore');
      const ac = (a.memory.data.discoveries ?? []).some((d) => d.what === 'cows');
      ok = bi && ac;
    }
    const lesson = (b.memory.data.lessons ?? []).some((l) => /stone pickaxe/.test(l));
    await stopAgents([a, b]);
    return { ok: ok && lesson, why: `B learned iron+lesson, A learned cows: ${ok} lesson=${lesson}` };
  },

  /** B asks where cows are; A knows and answers; B remembers the answer. */
  async ask_answer() {
    const [a, b] = await startAgents([
      { name: 'TestA_ask', x: X, z: Z },
      { name: 'TestB_ask', x: X + 5, z: Z },
    ]);
    a.memory.discover('cows', { x: X - 60, y: Y, z: Z + 20 });
    a.lastMeeting.set('TestB_ask', Date.now()); // they already met: the answer must come from the question
    await sleep(1500);
    b.bot.chat('Anyone know where cows are?');
    let got = false;
    for (let i = 0; i < 15 && !got; i++) {
      await sleep(1000);
      got = (b.memory.data.discoveries ?? []).some((d) => d.what === 'cows' && d.x === X - 60);
    }
    await stopAgents([a, b]);
    return { ok: got, why: `B learned where cows are from A's answer: ${got}` };
  },

  /** A newborn may not dig until taught; the mentor walks over, teaches 5 lessons, frees it. */
  async apprentice() {
    const [a, b] = await startAgents([
      { name: 'TestA_teach', x: X, z: Z },
      { name: 'TestB_born', x: X + 18, z: Z },
    ]);
    for (const l of ['gather iron_ore: need a stone pickaxe', 'Taught by TAdzi00: diamonds are below y 16', 'At night in the open, dig 3 down', 'craft torch: need coal', 'Conclusion: cows live on grass', 'Conclusion: lava is deadly']) a.memory.learn(l);
    a.memory.setPlace('home', { x: X, y: Y, z: Z });
    b.startApprenticeship(300);
    let refused = false;
    try {
      await b.bot.dig(b.bot.blockAt(b.bot.entity.position.offset(1, -1, 0)), true);
    } catch (e) {
      refused = /newborn/.test(String(e));
    }
    a.mentor(b);
    for (let i = 0; i < 40 && b.isApprentice(); i++) await sleep(1000);
    const freed = !b.isApprentice();
    const taught = (b.memory.data.lessons ?? []).filter((l) => /^From TestA_teach/.test(l)).length;
    const ap = a.position(), bp = b.position();
    const walked = ap && bp ? ap.distanceTo(bp) <= 9 : false;
    await stopAgents([a, b]);
    return { ok: refused && freed && taught >= 5 && walked, why: `dig refused=${refused} freed=${freed} lessons taught=${taught} mentor walked over=${walked}` };
  },

  /** A writes a library book (chest created in the village); B reads it and learns. */
  async library() {
    const [a, b] = await startAgents([
      { name: 'TestA_lib', x: X, z: Z },
      { name: 'TestB_lib', x: X + 3, z: Z + 3 },
    ]);
    a.deps.village.found({ x: X, y: Y, z: Z }, 'TestA_lib');
    a.lastMeeting.set('TestB_lib', Date.now()); // no talking: B must learn from the book
    for (const l of ['gather iron_ore: need a stone pickaxe', 'Taught by TAdzi00: diamonds are below y 16', 'craft torch: need coal']) a.memory.learn(l);
    a.memory.discover('iron_ore', { x: X + 50, y: Y - 30, z: Z });
    await cmd('give TestA_lib minecraft:writable_book 1');
    await cmd('give TestA_lib minecraft:chest 1');
    await sleep(1000);
    a.queueFirst({ skill: 'library_write', args: {}, thought: 'order from test' });
    for (let i = 0; i < 40 && !a.deps.village.data.library; i++) await sleep(1000);
    await sleep(4000);
    b.queueFirst({ skill: 'library_read', args: {}, thought: 'order from test' });
    let lessons = 0, iron = false;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      lessons = (b.memory.data.lessons ?? []).filter((l) => /^Library/.test(l)).length;
      iron = (b.memory.data.discoveries ?? []).some((d) => d.what === 'iron_ore');
      if (lessons >= 3 && iron) break;
    }
    await stopAgents([a, b]);
    return { ok: lessons >= 3 && iron, why: `library=${JSON.stringify(a.deps.village.data.library)} B learned ${lessons} lessons, iron=${iron}` };
  },

  /** News shouts reach a bot far away, which stores the find by kind. */
  async news() {
    const [a, b] = await startAgents([
      { name: 'TestA_news', x: X - 20, z: Z },
      { name: 'TestB_news', x: X + 20, z: Z },
    ]);
    await sleep(1500);
    a.news(`Found iron ore at ${X + 7} ${Y - 25} ${Z + 7}`);
    let got = false;
    for (let i = 0; i < 15 && !got; i++) {
      await sleep(1000);
      got = (b.memory.data.discoveries ?? []).some((d) => d.what === 'iron_ore' && d.x === X + 7);
    }
    await stopAgents([a, b]);
    return { ok: got, why: `B stored the shouted iron: ${got}` };
  },

  /** A announces a chest deposit within earshot; B's chest memory updates from hearing it. */
  async chest_report() {
    const [a, b] = await startAgents([
      { name: 'TestA_rep', x: X, z: Z },
      { name: 'TestB_rep', x: X + 4, z: Z },
    ]);
    await sleep(1500);
    a.bot.chat(`Stored 15 cobblestone, 5 bread in the chest at ${X + 2} ${Y} ${Z}`);
    await sleep(2000);
    const c = Object.values(b.memory.data.storage ?? {})[0];
    await stopAgents([a, b]);
    const ok = c?.items?.cobblestone === 15 && c?.items?.bread === 5 && c?.by === 'TestA_rep';
    return { ok, why: `B believes chest has ${JSON.stringify(c?.items)} (per ${c?.by})` };
  },

  /** Player order via /tell: "build shelter" runs instantly without the model. */
  async order() {
    const [a] = await startAgents([{ name: 'TestA_order', x: X, z: Z }]);
    await cmd(`give TestA_order minecraft:cobblestone 128`);
    await cmd(`give TestA_order minecraft:oak_planks 16`);
    await sleep(1500);
    await cmd(`tell TestA_order build shelter`);
    let walls = 0;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const p = await pos('TestA_order');
      if (!p) continue;
      const r = await cmd(`room raw ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`);
      if (/"sealed":true/.test(r)) {
        walls = 1;
        break;
      }
    }
    await stopAgents([a]);
    return { ok: walls === 1, why: walls ? 'sealed shelter built on order' : 'no sealed room after 90s' };
  },
};

const wanted = process.argv.slice(2);
let pass = 0;
const list = Object.entries(scenarios).filter(([n]) => !wanted.length || wanted.includes(n));
for (const [name, fn] of list) {
  await platform();
  let r;
  try {
    r = await Promise.race([fn(), sleep(200_000).then(() => ({ ok: false, why: 'timed out' }))]);
  } catch (e) {
    r = { ok: false, why: 'threw: ' + String(e?.stack ?? e).split('\n').slice(0, 2).join(' | ') };
  }
  await cleanup();
  if (r.ok) pass++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${name}: ${r.why}`);
}
console.log(`\n${pass}/${list.length} passed`);
rmSync('./state/agent-test', { recursive: true, force: true });
await rcon.close();
process.exit(0);
