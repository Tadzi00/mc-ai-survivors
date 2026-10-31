// Smoke test (live server): on a temporary platform at y=200, a ShelterTest bot builds a 5x5 shelter,
// extends it east, and RealisticSeasons reports whether the combined room is sealed. Cleans up after.
// Run from the repo root after `npm run build` with .env loaded: node scripts/shelter-test.mjs
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { buildShelterSkill, extendShelterSkill } from '../dist/skills/impl/building.js';
import { enableServerCrafting } from '../dist/skills/impl/resources.js';
import { Memory } from '../dist/bot/memory.js';
import { loadConfig } from '../dist/config.js';
import { RconClient } from '../dist/rcon/rcon.js';
const config = loadConfig();
const rcon = new RconClient(config.rcon);
const X = 3000, Y = 200, Z = 3000;
await rcon.send('whitelist add ShelterTest');
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'ShelterTest', auth: 'offline', version: '1.21.4' });
bot.loadPlugin(pf.pathfinder);
bot.once('spawn', async () => {
  const mv = new pf.Movements(bot); mv.scafoldingBlocks = []; mv.canOpenDoors = true; for (const b of Object.values(bot.registry.blocksByName)) if (/_door$|_planks$|glass|torch/.test(b.name)) mv.blocksCantBreak.add(b.id); bot.pathfinder.setMovements(mv);
  enableServerCrafting(bot, 'ShelterTest', rcon);
  await rcon.send(`forceload add ${X - 16} ${Z - 16} ${X + 16} ${Z + 16}`);
  await rcon.send(`fill ${X - 10} ${Y - 1} ${Z - 10} ${X + 14} ${Y - 1} ${Z + 10} minecraft:stone`);
  await rcon.send(`fill ${X - 10} ${Y} ${Z - 10} ${X + 14} ${Y + 5} ${Z + 10} minecraft:air`);
  await rcon.send(`tp ShelterTest ${X + 0.5} ${Y} ${Z + 0.5}`);
  await rcon.send('clear ShelterTest');
  await rcon.send('give ShelterTest minecraft:cobblestone 256');
  await rcon.send('give ShelterTest minecraft:oak_planks 12');
  await rcon.send('give ShelterTest minecraft:torch 4');
  await new Promise((r) => setTimeout(r, 4000));
  const ctx = { bot, name: 'ShelterTest', tier: 'smart', memory: new Memory('./state', 'ShelterTest', 40), seasons: { enabled: false }, config, signal: new AbortController().signal, log: (m) => console.log('  log:', m) };
  let lastY = bot.entity.position.y; const posLog = setInterval(() => { const p = bot.entity.position; if (Math.abs(p.y - lastY) > 0.5) { console.log(`  pos y ${lastY.toFixed(1)} -> ${p.y.toFixed(1)} at ${p.x.toFixed(1)},${p.z.toFixed(1)} pf=${bot.pathfinder.isMoving()}`); lastY = p.y; } }, 100);
  bot.on('physicsTick', () => {});
  console.log('build ->', await buildShelterSkill(ctx, { size: 5 }).catch((e) => 'THREW ' + e.message));
  console.log('room A:', await rcon.send(`room raw ${X} ${Y} ${Z}`));
  for (const [dx, dy, dz] of [[0,0,2],[0,1,2],[-1,0,-1],[-2,0,-2]]) console.log(`block ${dx},${dy},${dz}:`, await rcon.send(`execute if block ${X+dx} ${Y+dy} ${Z+dz} minecraft:air run say AIR_${dx}_${dy}_${dz}`));
  if (process.env.ONLY_BUILD) { bot.quit(); await rcon.send(`fill ${X - 10} ${Y - 1} ${Z - 10} ${X + 14} ${Y + 5} ${Z + 10} minecraft:air`); await rcon.send('whitelist remove ShelterTest'); setTimeout(() => process.exit(0), 500); return; }
  console.log('extend ->', await extendShelterSkill(ctx, { direction: 'east', length: 5 }).catch((e) => 'THREW ' + e.message));
  console.log('room A:', await rcon.send(`room raw ${X} ${Y} ${Z}`));
  console.log('room B:', await rcon.send(`room raw ${X + 4} ${Y} ${Z}`));
  if (process.env.PROBE) {
    const holes = [];
    for (let x = X - 2; x <= X + 6; x++) for (let z = Z - 2; z <= Z + 2; z++) for (let y = Y - 1; y <= Y + 3; y++) {
      const shell = x === X - 2 || x === X + 6 || z === Z - 2 || z === Z + 2 || y === Y - 1 || y === Y + 3;
      if (!shell) continue;
      const r = await rcon.send(`execute if block ${x} ${y} ${z} minecraft:air`);
      if (/passed/i.test(r)) holes.push(`${x - X},${y - Y},${z - Z}`);
    }
    console.log('HOLES (relative):', holes.join(' ') || 'none');
    console.log('door east wall?', await rcon.send(`execute if block ${X + 2} ${Y} ${Z} #minecraft:doors`));
  }
  bot.quit();
  await rcon.send(`fill ${X - 10} ${Y - 1} ${Z - 10} ${X + 14} ${Y + 5} ${Z + 10} minecraft:air`);
  await rcon.send(`forceload remove ${X - 16} ${Z - 16} ${X + 16} ${Z + 16}`);
  await rcon.send('whitelist remove ShelterTest');
  setTimeout(() => process.exit(0), 500);
});
bot.on('kicked', (r) => { console.log('kicked', r); process.exit(1); });
