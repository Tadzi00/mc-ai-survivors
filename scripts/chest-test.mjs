// Smoke test (live server): a ChestTest bot stores and takes items with the real chest skills.
// Run from the repo root after `npm run build` with .env loaded: node scripts/chest-test.mjs
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { chestStoreSkill, chestTakeSkill } from '../dist/skills/impl/storage.js';
import { Memory } from '../dist/bot/memory.js';
import { loadConfig } from '../dist/config.js';
import { RconClient } from '../dist/rcon/rcon.js';
const config = loadConfig();
const rcon = new RconClient(config.rcon);
await rcon.send('whitelist add ChestTest');
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'ChestTest', auth: 'offline', version: '1.21.4' });
bot.loadPlugin(pf.pathfinder);
const inv = () => bot.inventory.items().map((i) => `${i.count} ${i.name}`).join(', ') || 'empty';
bot.once('spawn', async () => {
  bot.pathfinder.setMovements(new pf.Movements(bot));
  await rcon.send('clear ChestTest');
  await rcon.send('give ChestTest minecraft:cobblestone 20');
  await rcon.send('give ChestTest minecraft:bread 5');
  await rcon.send('execute at ChestTest run setblock ~1 ~ ~ minecraft:chest');
  await new Promise((r) => setTimeout(r, 2500));
  const ctx = { bot, name: 'ChestTest', tier: 'smart', memory: new Memory('./state', 'ChestTest', 40), seasons: { enabled: false }, config, signal: new AbortController().signal, log: (m) => console.log('  log:', m) };
  console.log('start:', inv());
  console.log('store ->', await chestStoreSkill(ctx, { items: ['cobblestone:15', 'bread'] }).catch((e) => 'THREW ' + e.message));
  console.log('after store:', inv());
  console.log('take ->', await chestTakeSkill(ctx, { items: ['cobblestone:5'] }).catch((e) => 'THREW ' + e.message));
  console.log('after take:', inv());
  console.log('look ->', await chestTakeSkill(ctx, { items: ['list'] }).catch((e) => 'THREW ' + e.message));
  console.log('memory chest:', JSON.stringify(ctx.memory.place('chest')));
  console.log('SERVER bot cobble:', await rcon.send('clear ChestTest minecraft:cobblestone 0'));
  console.log('SERVER chest:', (await rcon.send('execute at ChestTest run data get block ~1 ~ ~ Items')).slice(0, 300));
  await rcon.send('execute at ChestTest run setblock ~1 ~ ~ minecraft:air');
  bot.quit();
  setTimeout(() => void rcon.send('whitelist remove ChestTest'), 300);
  setTimeout(() => process.exit(0), 500);
});
bot.on('kicked', (r) => { console.log('kicked', r); process.exit(1); });
