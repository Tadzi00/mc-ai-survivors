// Smoke test (live server): a CraftTest bot gets 4 logs via RCON and crafts pickaxe/sword/sticks with the
// real craft skill. Run from the repo root after `npm run build`: node scripts/craft-test.mjs (needs .env loaded).
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { craftSkill, enableServerCrafting } from '../dist/skills/impl/resources.js';
import { Memory } from '../dist/bot/memory.js';
import { loadConfig } from '../dist/config.js';
import { RconClient } from '../dist/rcon/rcon.js';
const config = loadConfig();
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'CraftTest', auth: 'offline', version: '1.21.4' });
bot.loadPlugin(pf.pathfinder);
const inv = () => bot.inventory.items().map((i) => `${i.count} ${i.name}`).join(', ') || 'empty';
bot.once('spawn', async () => {
  bot.pathfinder.setMovements(new pf.Movements(bot));
  const rcon = new RconClient(config.rcon);
  enableServerCrafting(bot, 'CraftTest', rcon);
  await rcon.send('clear CraftTest');
  await rcon.send('give CraftTest minecraft:oak_log 4');
  await new Promise((r) => setTimeout(r, 2000));
  console.log('start inv:', inv());
  if (0) bot.inventory.on('updateSlot', (slot, o, n) => console.log(`  slot ${slot}: ${o ? o.count + ' ' + o.name : '-'} -> ${n ? n.count + ' ' + n.name : '-'}`));
  bot.on('windowOpen', (w) => console.log('  window open', w.type));
  bot.on('windowClose', (w) => console.log('  window close', w.type));
  const ctx = { bot, name: 'CraftTest', tier: 'smart', memory: new Memory('./state', 'CraftTest', 40), seasons: { enabled: false }, config, signal: new AbortController().signal, log: (m) => console.log('  log:', m) };
  for (const item of ['wooden_pickaxe', 'wooden_sword', 'stick']) {
    const r = await craftSkill(ctx, { item, count: 1 }).catch((e) => 'THREW: ' + e.message);
    console.log(item, '->', r);
    console.log('inv now:', inv());
    await new Promise((r) => setTimeout(r, 1500));
    console.log('inv +1.5s:', inv());
  }
  console.log('SERVER inv:', (await rcon.send('data get entity CraftTest Inventory')).slice(0, 400));
  console.log('ITEMS near:', (await rcon.send('execute at CraftTest run data get entity @e[type=item,distance=..6,limit=1] Item')).slice(0,200));
  console.log('TABLE near:', await rcon.send('execute at CraftTest if block ~1 ~ ~ crafting_table run say table_east'));
  console.log('SERVER table:', await rcon.send('clear CraftTest minecraft:crafting_table 0'));
  bot.quit();
  setTimeout(() => process.exit(0), 500);
});
bot.on('kicked', (r) => { console.log('kicked', r); process.exit(1); });
bot.on('error', (e) => { console.log('error', e.message); process.exit(1); });
