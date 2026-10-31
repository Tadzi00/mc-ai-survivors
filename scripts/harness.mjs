// Live test harness: runs skill scenarios with a real mineflayer bot on a temporary stone platform far from
// the play area (x≈3000, y=200), checks results through RCON (server truth), then removes everything.
// Usage (repo root, after `npm run build`, with .env loaded):
//   node scripts/harness.mjs            # all scenarios
//   node scripts/harness.mjs signs books
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock';
import { plugin as toolPlugin } from 'mineflayer-tool';
import { plugin as pvpPlugin } from 'mineflayer-pvp';
import { loadConfig } from '../dist/config.js';
import { RconClient } from '../dist/rcon/rcon.js';
import { SeasonsApi } from '../dist/rcon/server.js';
import { Memory } from '../dist/bot/memory.js';
import { MAN_MADE_RE } from '../dist/skills/helpers.js';
import { enableServerCrafting } from '../dist/skills/impl/resources.js';
import { scenarios } from './scenarios.mjs';
import { rmSync } from 'node:fs';

const config = loadConfig();
const rcon = new RconClient(config.rcon);
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
export const cmd = async (c) => strip(await rcon.send(c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const X = 3000, Y = 200, Z = 3000, R = 12;

async function platform() {
  await cmd(`forceload add ${X - R - 4} ${Z - R - 4} ${X + R + 4} ${Z + R + 4}`);
  await cmd(`fill ${X - R} ${Y} ${Z - R} ${X + R} ${Y + 8} ${Z + R} minecraft:air`);
  await cmd(`fill ${X - R} ${Y - 3} ${Z - R} ${X + R} ${Y - 3} ${Z + R} minecraft:bedrock`);
  await cmd(`fill ${X - R} ${Y - 2} ${Z - R} ${X + R} ${Y - 1} ${Z + R} minecraft:stone`);
  // light ceiling: no natural mob spawns on the test platform even at night
  await cmd(`fill ${X - R} ${Y + 7} ${Z - R} ${X + R} ${Y + 7} ${Z + R} minecraft:light[level=15]`);
  await cmd(`kill @e[type=!player,x=${X - R},y=${Y - 2},z=${Z - R},dx=${2 * R},dy=12,dz=${2 * R}]`);
}

async function cleanup() {
  await cmd(`fill ${X - R} ${Y - 3} ${Z - R} ${X + R} ${Y + 8} ${Z + R} minecraft:air`);
  await cmd(`kill @e[type=!player,x=${X - R},y=${Y - 2},z=${Z - R},dx=${2 * R},dy=12,dz=${2 * R}]`);
  await cmd(`forceload remove ${X - R - 4} ${Z - R - 4} ${X + R + 4} ${Z + R + 4}`);
}

function spawnBot(name) {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: name, auth: 'offline', version: '1.21.4', hideErrors: true });
    bot.loadPlugin(pf.pathfinder);
    bot.loadPlugin(collectBlockPlugin);
    bot.loadPlugin(toolPlugin);
    bot.loadPlugin(pvpPlugin);
    bot.once('spawn', () => {
      // Same movement rules as the real agent.
      const mv = new pf.Movements(bot);
      mv.canDig = true;
      mv.allowParkour = false;
      mv.canOpenDoors = true;
      mv.scafoldingBlocks = [];
      mv.allow1by1towers = false;
      for (const b of Object.values(bot.registry.blocksByName)) if (MAN_MADE_RE.test(b.name)) mv.blocksCantBreak.add(b.id);
      // same no-dig zone as the agent: within 4 blocks of home, or touching man-made blocks
      mv.exclusionAreasBreak.push((block) => {
        const p = block.position;
        if (MAN_MADE_RE.test(block.name)) return 1000;
        for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
          const n = bot.blockAt(p.offset(dx, dy, dz));
          if (n && MAN_MADE_RE.test(n.name)) return 1000;
        }
        const home = bot.__memory?.place('home');
        return home && Math.abs(p.x - home.x) <= 4 && Math.abs(p.z - home.z) <= 4 && p.y >= home.y - 1 && p.y <= home.y + 4 ? 1000 : 0;
      });
      bot.pathfinder.setMovements(mv);
      enableServerCrafting(bot, name, rcon);
      resolve(bot);
    });
    bot.once('kicked', (r) => reject(new Error('kicked ' + JSON.stringify(r))));
    bot.once('error', reject);
  });
}

async function runScenario(name, sc) {
  const botName = 'Test_' + name.slice(0, 10);
  await cmd(`whitelist add ${botName}`);
  await platform();
  const bot = await spawnBot(botName);
  await cmd(`clear ${botName}`);
  await cmd(`gamemode survival ${botName}`);
  await cmd(`effect clear ${botName}`);
  await cmd(`tp ${botName} ${X + 0.5} ${Y} ${Z + 0.5}`);
  await sleep(1500);
  const memory = new Memory('./state/test', botName, 40);
  memory.data = { name: botName, goal: null, notes: [], places: {} };
  bot.__memory = memory;
  const logs = [];
  const ctx = {
    bot, name: botName, tier: 'smart', memory, seasons: new SeasonsApi(rcon), config,
    signal: new AbortController().signal, log: (m) => logs.push(m),
  };
  const P = { X, Y, Z, cmd, sleep, give: (item, n = 1) => cmd(`give ${botName} minecraft:${item} ${n}`), botName };
  let result;
  try {
    result = await Promise.race([sc(ctx, P), sleep(180_000).then(() => ({ ok: false, why: 'scenario timed out (180s)' }))]);
  } catch (e) {
    result = { ok: false, why: 'threw: ' + (e?.stack ?? e).toString().split('\n').slice(0, 3).join(' | ') };
  }
  bot.quit();
  await sleep(500);
  await cleanup();
  await cmd(`whitelist remove ${botName}`);
  return { ...result, logs };
}

const wanted = process.argv.slice(2);
const list = Object.entries(scenarios).filter(([n]) => wanted.length === 0 || wanted.includes(n));
let pass = 0;
for (const [name, sc] of list) {
  const r = await runScenario(name, sc);
  if (r.ok) pass++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${name}: ${r.why ?? ''}`);
  if ((!r.ok || process.env.VERBOSE) && r.logs.length) for (const l of r.logs.slice(-12)) console.log('     log:', String(l).slice(0, 220));
}
console.log(`\n${pass}/${list.length} passed`);
rmSync('./state/test', { recursive: true, force: true });
await rcon.close();
process.exit(0);
