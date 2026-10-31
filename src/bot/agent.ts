import mineflayer, { type Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock';
import { plugin as toolPlugin } from 'mineflayer-tool';
import { plugin as pvpPlugin } from 'mineflayer-pvp';
import type { Entity } from 'prismarine-entity';
import type { Config } from '../config.js';
import type { BedPos, SeasonsReading } from '../contracts.js';
import type { Tier } from '../lifecycle/policy.js';
import type { LLMRegistry } from '../llm/factory.js';
import type { ChatMessage } from '../llm/types.js';
import type { SeasonsApi } from '../rcon/server.js';
import type { SkillContext } from '../skills/context.js';
import { countItem, findBlocks, fmtPos, gotoNear, gotoXZ, HOSTILE_MOBS } from '../skills/helpers.js';
import { runSkill } from '../skills/index.js';
import { eatSkill, sleepSkill } from '../skills/impl/survival.js';
import { placeTorchSkill } from '../skills/impl/building.js';
import { JsonlLog, log, shortHash } from '../util/log.js';
import { AbortError, sleep, TimeoutError } from '../util/time.js';
import { fallbackAction, looksFailed, parsePlan, type PlannedAction } from './action.js';
import { shoutCooldownLeft, tryShout } from '../skills/impl/knowledge.js';
import { lessonFrom } from './memory.js';
import { classifyChat } from './chat.js';
import { ChatLog, Roster } from './chat.js';
import { Memory } from './memory.js';
import { buildObservation } from './observation.js';
import { retryPrompt, systemPrompt } from './prompts.js';
import { chooseReflex, type Reflex, type ReflexState } from './reflexChoice.js';

const { pathfinder, Movements } = pathfinderPkg;

export interface AgentDeps {
  config: Config;
  llm: LLMRegistry;
  seasons: SeasonsApi;
  /** Positions of all bots in this orchestrator (shout range for bots out of entity view). */
  roster: Roster;
}

export interface AgentEvents {
  onSpawn(agent: BotAgent): void;
  onDeath(agent: BotAgent, cause: string): void;
  onDisconnect(agent: BotAgent, reason: string): void;
}

/** Entity metadata index 0 is a bit field; bit 0x01 = on fire. */
const isOnFire = (flags: unknown): boolean => typeof flags === 'number' && (flags & 0x01) === 1;

/** What the discovery scan looks for (label, block-name predicate). */
const DISCOVERY_BLOCKS: Array<[string, (n: string) => boolean]> = [
  ['coal_ore', (n) => n === 'coal_ore' || n === 'deepslate_coal_ore'],
  ['iron_ore', (n) => n === 'iron_ore' || n === 'deepslate_iron_ore'],
  ['copper_ore', (n) => n === 'copper_ore' || n === 'deepslate_copper_ore'],
  ['gold_ore', (n) => n === 'gold_ore' || n === 'deepslate_gold_ore'],
  ['diamond_ore', (n) => n === 'diamond_ore' || n === 'deepslate_diamond_ore'],
  ['water', (n) => n === 'water'],
  ['lava (danger)', (n) => n === 'lava'],
  ['sand', (n) => n === 'sand'],
  ['clay', (n) => n === 'clay'],
  ['sugar_cane', (n) => n === 'sugar_cane'],
];
const ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit']);

/** Blocks the unstuck routine must never break (homes, utility, other bots' work). */
const NEVER_DIG = /door|_bed$|chest|barrel|crafting_table|furnace|smoker|torch|lantern|_sign$|lectern|glass|bedrock|_wool$|farmland|campfire/;

const REFLEX_COOLDOWN_MS: Partial<Record<Reflex, number>> = {
  eat: 5_000,
  sleep: 60_000,
  warm_torch: 120_000,
  warm_home: 60_000,
};

/**
 * One survivor. Two layers (see DESIGN.md):
 *  - reflexes: fast, no LLM, run every `reflexIntervalMs`, may interrupt the current skill
 *  - planner:  LLM picks ONE skill when idle; the skill runs deterministically with a timeout
 */
export class BotAgent {
  bot: Bot | undefined;
  readonly memory: Memory;
  private readonly chat: ChatLog;
  private readonly jsonl: JsonlLog;
  private running = false;
  /** For the idle watchdog: is the bot waiting on the model right now, and where it was recently. */
  private planningSince = 0;
  private posHistory: Array<{ t: number; x: number; y: number; z: number }> = [];
  private lastIdleWarn = 0;
  /** Remaining steps of the current multi-step plan (smart bots). Cleared when something changes. */
  private planQueue: PlannedAction[] = [];
  private planNote: string | undefined;
  private lastSpokeAt = Date.now();
  /** Stuck-while-walking detection (see unstickTick). */
  private moveTrack: Array<{ t: number; x: number; y: number; z: number }> = [];
  private stuckTries = 0;
  private unsticking = false;
  private dead = false;
  private skillAbort: AbortController | undefined;
  private currentSkill: string | undefined;
  private reflexBusy = false;
  private interruptedBy: string | undefined;
  private lastPlanAt = 0;
  private readonly recentResults: string[] = [];
  private readonly reflexLastRun = new Map<Reflex, number>();
  private temp: SeasonsReading | undefined;
  private timers: NodeJS.Timeout[] = [];
  private recentSystemMsgs: Array<{ at: number; text: string }> = [];
  private lastHealth = 20;

  constructor(
    readonly name: string,
    readonly tier: Tier,
    private readonly deps: AgentDeps,
    private readonly events: AgentEvents,
    private readonly birthBed?: BedPos | null,
  ) {
    const { paths, bot: b } = deps.config;
    this.memory = new Memory(paths.state, name, b.notesMax);
    this.chat = new ChatLog(b.chatHistory);
    this.jsonl = new JsonlLog(paths.logs, name);
    if (birthBed && !this.memory.place('bed')) {
      this.memory.setPlace('bed', birthBed);
      this.memory.addNote(`I was born at my own bed ${birthBed.x},${birthBed.y},${birthBed.z}. Keep that room sealed and warm.`);
    }
  }

  get isDead(): boolean {
    return this.dead;
  }

  start(): void {
    const { server } = this.deps.config;
    const bot = mineflayer.createBot({
      host: server.host,
      port: server.port,
      username: this.name,
      auth: 'offline',
      ...(server.version === 'auto' ? {} : { version: server.version }),
      hideErrors: true,
    });
    this.bot = bot;
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlockPlugin);
    bot.loadPlugin(toolPlugin);
    bot.loadPlugin(pvpPlugin);

    bot.once('spawn', () => {
      const moves = new Movements(bot);
      moves.canDig = true;
      moves.allowParkour = false; // fewer fatal falls
      moves.allowSprinting = true;
      // Use doors instead of digging through walls (Paper handles door opening fine).
      moves.canOpenDoors = true;
      // Never dig through our own (or a known) shelter: breaking blocks near home costs a fortune.
      moves.exclusionAreasBreak.push((block: { position: { x: number; y: number; z: number } }) => {
        const home = this.memory.place('home');
        if (!home) return 0;
        const p = block.position;
        return Math.abs(p.x - home.x) <= 4 && Math.abs(p.z - home.z) <= 4 && p.y >= home.y - 1 && p.y <= home.y + 4 ? 1000 : 0;
      });
      bot.pathfinder.setMovements(moves);
      this.running = true;
      this.lastHealth = bot.health;
      this.log('info', `spawned at ${bot.entity.position.floored().toString()}`);
      this.jsonl.write('spawn', { tier: this.tier, pos: bot.entity.position });
      this.events.onSpawn(this);
      this.timers.push(setInterval(() => void this.reflexTick(), this.deps.config.bot.reflexIntervalMs));
      this.timers.push(setInterval(() => this.idleWatchdog(), 10_000));
      this.timers.push(setInterval(() => this.scanDiscoveries(), 15_000));
      this.timers.push(setInterval(() => void this.unstickTick(), 1_000));
      this.timers.push(setInterval(() => void this.temperatureTick(), this.deps.config.bot.temperatureCheckSeconds * 1000));
      void this.temperatureTick();
      void this.plannerLoop();
    });

    bot.on('chat', (username, message) => {
      const speakerPos = bot.players[username]?.entity?.position ?? this.deps.roster.get(username);
      const ranges = { say: this.deps.config.chatRange, shout: this.deps.config.shout.range };
      if (this.chat.offer(this.name, username, message, bot.entity?.position, speakerPos, ranges)) {
        this.jsonl.write('heard', { from: username, text: message });
        this.rememberShout(username, message, speakerPos);
        this.wakePlanner('chat');
      }
    });
    bot.on('messagestr', (msg, position) => {
      if (position === 'system' || position === 'game_info') {
        this.recentSystemMsgs.push({ at: Date.now(), text: msg });
        this.recentSystemMsgs = this.recentSystemMsgs.filter((m) => Date.now() - m.at < 10_000);
        this.noteDeathOfOther(msg);
      }
    });
    bot.on('health', () => {
      if (bot.health < this.lastHealth - 0.5) {
        this.wakePlanner('hurt');
        this.maybeCallForHelp();
      }
      this.lastHealth = bot.health;
    });
    bot.on('death', () => void this.handleDeath());
    bot.on('kicked', (reason) => this.log('warn', `kicked: ${String(reason)}`));
    bot.on('error', (err) => this.log('warn', `error: ${err.message}`));
    bot.on('end', (reason) => {
      this.cleanup();
      if (!this.dead) this.events.onDisconnect(this, String(reason));
    });
  }

  /** Disconnect without marking dead (orchestrator shutdown). */
  stop(reason = 'shutdown'): void {
    this.running = false;
    this.cleanup();
    this.bot?.quit(reason);
  }

  private cleanup(): void {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.skillAbort?.abort();
  }

  private async handleDeath(): Promise<void> {
    if (this.dead) return;
    this.dead = true;
    this.deps.roster.remove(this.name);
    const bot = this.bot!;
    // Server death message usually arrives just before/after the death event.
    await sleep(500);
    const msg = this.recentSystemMsgs.reverse().find((m) => m.text.includes(this.name));
    const cause = msg?.text ?? `died (food ${bot.food}, at ${bot.entity?.position?.floored().toString() ?? '?'})`;
    this.log('warn', `DIED permanently: ${cause}`);
    this.jsonl.write('death', { cause, pos: bot.entity?.position, inventory: bot.inventory.items().map((i) => `${i.count} ${i.name}`) });
    this.cleanup();
    this.events.onDeath(this, cause);
    bot.quit('dead');
  }

  private log(level: 'info' | 'warn' | 'debug' | 'error', msg: string): void {
    log(level, this.name, msg);
  }

  private wakePlanner(reason: string): void {
    // New information (chat, getting hurt): finish the current step, then re-plan with fresh state.
    if (this.planQueue.length) {
      this.planNote = `plan paused after: ${reason}; remaining steps were ${this.planQueue.map((p) => p.skill).join(', ')}`;
      this.planQueue = [];
    }
    // Only interrupt passive skills; real work continues.
    if (this.currentSkill === 'wait' || this.currentSkill === 'follow') {
      this.skillAbort?.abort();
      this.interruptedBy = reason;
    }
  }

  private makeCtx(signal: AbortSignal): SkillContext {
    return {
      bot: this.bot!,
      name: this.name,
      tier: this.tier,
      memory: this.memory,
      seasons: this.deps.seasons,
      config: this.deps.config,
      signal,
      log: (m) => this.log('debug', m),
    };
  }

  // ---------------------------------------------------------------- seasons
  private async temperatureTick(): Promise<void> {
    const bot = this.bot;
    if (!this.running || !bot?.entity || !this.deps.seasons.enabled) return;
    const p = bot.entity.position;
    this.temp = await this.deps.seasons.temp(p.x, p.y, p.z).catch(() => undefined);
  }

  // ---------------------------------------------------------------- reflexes
  // ---------------------------------------------------------------- auto memory & social

  /** Every 15 s: remember notable resources, dangers and animals within 32 blocks (no model involved). */
  private scanDiscoveries(): void {
    const bot = this.bot;
    if (!this.running || !bot?.entity) return;
    const all = Object.keys(bot.registry.blocksByName);
    for (const [what, pred] of DISCOVERY_BLOCKS) {
      const b = findBlocks(bot, all.filter(pred), 32, 1)[0];
      if (b && this.memory.discover(what, b.position)) this.jsonl.write('discovery', { what, pos: b.position });
    }
    for (const e of Object.values(bot.entities)) {
      if (!e.name || !ANIMALS.has(e.name) || !e.position || e.position.distanceTo(bot.entity.position) > 32) continue;
      if (this.memory.discover(`${e.name}s`, e.position)) this.jsonl.write('discovery', { what: e.name, pos: e.position });
    }
  }

  /** Server death messages are global: learn who died, how, and (if known) where. */
  private noteDeathOfOther(msg: string): void {
    const m = /^(\w{3,16}) (was |died|drowned|fell|burned|froze|hit the ground|tried to swim|walked into|starved|suffocated|blew up|withered)/.exec(msg);
    if (!m || m[1] === this.name) return;
    const where = this.deps.roster.get(m[1]!, 120_000);
    const text = `${msg}${where ? ` near ${Math.floor(where.x)},${Math.floor(where.y)},${Math.floor(where.z)}` : ''}`;
    this.memory.learn(`DEATH: ${text}`);
    if (where) this.memory.discover(`danger (${msg.slice(m[1]!.length + 1, m[1]!.length + 30)})`, where);
  }

  /** Shouts with coordinates become discoveries; a shouted village becomes the "village" place. */
  private rememberShout(from: string, raw: string, speakerPos: { x: number; y: number; z: number } | undefined): void {
    const { kind, text } = classifyChat(raw);
    if (kind !== 'shout') return;
    const c = /(-?\d{1,6})[ ,]+(-?\d{1,4})[ ,]+(-?\d{1,6})/.exec(text);
    const pos = c ? { x: Number(c[1]), y: Number(c[2]), z: Number(c[3]) } : speakerPos;
    if (!pos) return;
    if (/village|town|base|meet/i.test(text) && !this.memory.place('village')) {
      this.memory.setPlace('village', { ...pos, note: `shouted by ${from}` });
      this.memory.learn(`${from} shouted the village location: ${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`);
    } else if (!/help|attack/i.test(text)) {
      this.memory.discover(`spot shouted by ${from}: ${text.slice(0, 40)}`, pos);
    }
  }

  /** Attacked by a hostile: shout for help with coordinates (scripted; uses the normal shout cooldown). */
  private maybeCallForHelp(): void {
    const bot = this.bot;
    if (!bot?.entity) return;
    const attacker = this.hostilesWithin(6)[0];
    if (!attacker) return;
    const p = bot.entity.position;
    const text = `HELP! ${attacker.name ?? 'mob'} attacking me at ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;
    if (!tryShout(bot, this.name, text, this.deps.config.shout)) {
      this.jsonl.write('help_shout', { attacker: attacker.name, pos: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } });
    }
  }

  /**
   * The pathfinder sometimes keeps "walking" into a block (corner it can't pass, block that appeared on
   * the route). If it is moving but the bot hasn't advanced 0.3 blocks in 3 s: dig the block in front at
   * head/feet height (never near home or utility blocks), else jump. After 3 tries, stop the pathfinder so
   * the skill fails and picks something else.
   */
  private async unstickTick(): Promise<void> {
    const bot = this.bot;
    if (!this.running || !bot?.entity) return;
    this.deps.roster.update(this.name, bot.entity.position);
    if (this.unsticking) return;
    if (!bot.pathfinder.isMoving() || bot.isSleeping) {
      this.moveTrack = [];
      this.stuckTries = 0;
      return;
    }
    const now = Date.now();
    const p = bot.entity.position;
    this.moveTrack.push({ t: now, x: p.x, y: p.y, z: p.z });
    this.moveTrack = this.moveTrack.filter((h) => now - h.t <= 3_500);
    if (now - this.moveTrack[0]!.t < 2_900) return;
    const moved = Math.max(...this.moveTrack.map((h) => Math.hypot(h.x - p.x, h.y - p.y, h.z - p.z)));
    if (moved >= 0.3) {
      this.stuckTries = 0;
      return;
    }
    this.unsticking = true;
    this.moveTrack = [];
    this.stuckTries++;
    try {
      if (this.stuckTries > 3) {
        this.log('info', `stuck at ${fmtPos(p)} - giving up on this path`);
        this.jsonl.write('stuck', { pos: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, action: 'gave_up' });
        bot.pathfinder.stop();
        this.stuckTries = 0;
        return;
      }
      const yaw = bot.entity.yaw;
      const front = p.offset(-Math.sin(yaw), 0, -Math.cos(yaw)).floored();
      const home = this.memory.place('home');
      const nearHome = !!home && Math.hypot(front.x - home.x, front.z - home.z) < 6;
      for (const b of [bot.blockAt(front.offset(0, 1, 0)), bot.blockAt(front)]) {
        if (!b || b.boundingBox !== 'block' || nearHome || NEVER_DIG.test(b.name) || !bot.canDigBlock(b)) continue;
        this.jsonl.write('stuck', { pos: { x: front.x, y: front.y, z: front.z }, action: `dig ${b.name}` });
        await bot.dig(b, true).catch(() => undefined);
        return;
      }
      this.jsonl.write('stuck', { pos: { x: front.x, y: front.y, z: front.z }, action: 'jump' });
      bot.setControlState('jump', true);
      await sleep(400);
      bot.setControlState('jump', false);
    } finally {
      this.unsticking = false;
    }
  }

  /**
   * Warns (log + jsonl "idle") when the bot hasn't moved for 30 s and isn't sleeping, saying what it is
   * waiting on, so stuck bots get noticed. Diagnostic only; it does not change behaviour.
   */
  private idleWatchdog(): void {
    const bot = this.bot;
    if (!this.running || !bot?.entity) return;
    const now = Date.now();
    const p = bot.entity.position;
    this.posHistory.push({ t: now, x: p.x, y: p.y, z: p.z });
    this.posHistory = this.posHistory.filter((h) => now - h.t <= 35_000);
    const oldest = this.posHistory[0]!;
    if (now - oldest.t < 29_000 || bot.isSleeping) return;
    const moved = Math.max(...this.posHistory.map((h) => Math.hypot(h.x - p.x, h.y - p.y, h.z - p.z)));
    if (moved >= 1 || now - this.lastIdleWarn < 60_000) return;
    this.lastIdleWarn = now;
    const what = this.planningSince
      ? `waiting for the model for ${Math.round((now - this.planningSince) / 1000)}s`
      : this.reflexBusy
        ? 'running a reflex'
        : this.currentSkill
          ? `skill "${this.currentSkill}" running but not moving`
          : 'doing nothing (between actions)';
    this.log('warn', `IDLE: hasn't moved for 30s - ${what}`);
    this.jsonl.write('idle', { what, skill: this.currentSkill ?? null, pos: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } });
  }

  private hostilesWithin(radius: number): Entity[] {
    const bot = this.bot!;
    return Object.values(bot.entities).filter(
      (e) => !!e.name && HOSTILE_MOBS.has(e.name) && !!e.position && e.position.distanceTo(bot.entity.position) <= radius,
    );
  }

  /** Sprint away from nearby hostiles until none is within `safe` blocks (or time runs out). */
  private async runAway(ctx: SkillContext, signal: AbortSignal, maxMs: number, safe = 14): Promise<string> {
    const bot = this.bot!;
    const end = Date.now() + maxMs;
    bot.setControlState('sprint', true);
    try {
      while (Date.now() < end) {
        const threats = this.hostilesWithin(safe);
        if (threats.length === 0) return 'escaped';
        const me = bot.entity.position;
        // run directly away from the average threat position
        let ax = 0;
        let az = 0;
        for (const t of threats) {
          ax += me.x - t.position.x;
          az += me.z - t.position.z;
        }
        const len = Math.max(0.1, Math.hypot(ax, az));
        await gotoXZ(ctx, me.x + (ax / len) * 12, me.z + (az / len) * 12, 3_000).catch(() => undefined);
        if (signal.aborted) return 'aborted';
      }
      return this.hostilesWithin(safe).length ? 'still chased' : 'escaped';
    } finally {
      bot.setControlState('sprint', false);
    }
  }

  private nearestHostile(): Entity | undefined {
    const bot = this.bot!;
    let best: Entity | undefined;
    let bestD = Infinity;
    for (const e of Object.values(bot.entities)) {
      if (!e.name || !HOSTILE_MOBS.has(e.name) || !e.position) continue;
      const d = e.position.distanceTo(bot.entity.position);
      if (d < bestD) {
        best = e;
        bestD = d;
      }
    }
    return best;
  }

  private reflexState(hostile: Entity | undefined): ReflexState {
    const bot = this.bot!;
    const feet = bot.blockAt(bot.entity.position);
    const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
    const cfg = this.deps.config.bot;
    const t = this.temp;
    return {
      health: bot.health,
      food: bot.food,
      oxygen: bot.oxygenLevel ?? 20,
      hasFood: bot.inventory.items().some((i) => bot.registry.foodsByName[i.name] && !/rotten|spider_eye|poisonous/.test(i.name)),
      inLava: feet?.name === 'lava' || head?.name === 'lava',
      onFire: isOnFire(bot.entity.metadata?.[0] as unknown),
      inWater: feet?.name === 'water' || head?.name === 'water',
      hostile: hostile ? { distance: hostile.position.distanceTo(bot.entity.position), type: hostile.name ?? 'mob' } : undefined,
      nearbyHostiles: this.hostilesWithin(10).length,
      hasWeapon: bot.inventory.items().some((i) => /_sword$|_axe$/.test(i.name)),
      isNight: bot.time.timeOfDay >= 12_600 && bot.time.timeOfDay <= 23_000,
      isSleeping: bot.isSleeping,
      bedKnown: !!this.memory.place('bed'),
      cold: t && this.deps.seasons.enabled ? !t.comfortable && t.tempC < cfg.coldThresholdC : undefined,
      hasTorch: countItem(bot, 'torch') > 0,
      homeKnown: !!this.memory.place('home'),
    };
  }

  private async reflexTick(): Promise<void> {
    if (!this.running || this.reflexBusy || !this.bot?.entity) return;
    const hostile = this.nearestHostile();
    const choice = chooseReflex(this.reflexState(hostile));
    if (!choice) return;
    const cd = REFLEX_COOLDOWN_MS[choice];
    if (cd && Date.now() - (this.reflexLastRun.get(choice) ?? 0) < cd) return;
    // Don't fight what the current skill is already fighting.
    if (choice === 'fight' && this.currentSkill === 'attack') return;
    if (choice === 'sleep' && this.currentSkill === 'sleep') return;
    this.reflexLastRun.set(choice, Date.now());
    this.reflexBusy = true;
    if (this.skillAbort && this.currentSkill) {
      this.interruptedBy = choice;
      this.skillAbort.abort();
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), choice === 'fight' ? 60_000 : 25_000);
    const started = Date.now();
    let result = '';
    try {
      result = await this.runReflex(choice, hostile, ac.signal);
    } catch (e) {
      result = e instanceof AbortError ? 'aborted' : `failed: ${(e as Error).message}`;
    } finally {
      clearTimeout(timer);
      this.reflexBusy = false;
    }
    this.log('debug', `reflex ${choice}: ${result}`);
    this.jsonl.write('reflex', { reflex: choice, result, ms: Date.now() - started });
  }

  private async runReflex(r: Reflex, hostile: Entity | undefined, signal: AbortSignal): Promise<string> {
    const bot = this.bot!;
    const ctx = this.makeCtx(signal);
    switch (r) {
      case 'escape_lava':
      case 'extinguish':
      case 'surface': {
        bot.pathfinder.stop();
        bot.setControlState('jump', true);
        bot.setControlState('forward', r !== 'surface');
        try {
          await sleep(r === 'surface' ? 1500 : 1200, signal);
        } finally {
          bot.clearControlStates();
        }
        return 'moved';
      }
      case 'fight': {
        if (!hostile) return 'no target';
        const weapon = bot.inventory.items().find((i) => /_sword$|_axe$/.test(i.name));
        if (weapon) await bot.equip(weapon, 'hand').catch(() => undefined);
        // Fight until the target dies or leaves; retarget to the next close hostile; bail out (and run)
        // when health gets low. Bounded so the planner gets a turn eventually.
        let target: Entity | undefined = hostile;
        let kills = 0;
        const end = Date.now() + 40_000;
        try {
          while (target && Date.now() < end) {
            if (bot.health < 8) {
              await bot.pvp.stop().catch(() => bot.pvp.forceStop());
              return `low health after ${kills} kill(s): ${await this.runAway(ctx, signal, 15_000)}`;
            }
            if (bot.pvp.target !== target) void bot.pvp.attack(target);
            await sleep(300, signal);
            const gone = !target.isValid || !bot.entities[target.id] || target.position.distanceTo(bot.entity.position) > 16;
            if (gone) {
              if (!target.isValid || !bot.entities[target.id]) kills++;
              target = this.hostilesWithin(8)[0];
            }
          }
        } finally {
          await bot.pvp.stop().catch(() => bot.pvp.forceStop());
        }
        return target ? `still fighting after 40s (${kills} kill(s))` : `won (${kills} kill(s))`;
      }
      case 'flee': {
        const home = this.memory.place('home');
        if (home && home.x !== undefined && bot.entity.position.distanceTo(bot.entity.position.clone().set(home.x, home.y, home.z)) < 40) {
          bot.setControlState('sprint', true);
          await gotoNear(ctx, home.x, home.y, home.z, 1, 15_000).catch(() => undefined);
          bot.setControlState('sprint', false);
          return 'fled home';
        }
        if (!hostile) return 'nothing to flee';
        return this.runAway(ctx, signal, 15_000);
      }
      case 'eat':
        return eatSkill(ctx);
      case 'warm_home': {
        const home = this.memory.place('home')!;
        if (bot.entity.position.distanceTo(bot.entity.position.clone().set(home.x, home.y, home.z)) > 3) {
          await gotoNear(ctx, home.x, home.y, home.z, 1, 18_000).catch(() => undefined);
          return 'went home to warm up';
        }
        return countItem(bot, 'torch') > 0 ? placeTorchSkill(ctx) : 'at home but no torch';
      }
      case 'warm_torch':
        return placeTorchSkill(ctx);
      case 'sleep':
        return sleepSkill(ctx);
    }
  }

  // ---------------------------------------------------------------- planner
  private async plannerLoop(): Promise<void> {
    const minInterval = this.deps.config.bot.plannerMinIntervalSeconds * 1000;
    while (this.running) {
      if (this.reflexBusy || Date.now() - this.lastPlanAt < minInterval || !this.bot?.entity) {
        await sleep(250);
        continue;
      }
      let action: PlannedAction;
      if (this.planQueue.length) {
        // Next step of the current plan: no model call needed.
        action = this.planQueue.shift()!;
      } else {
        this.lastPlanAt = Date.now();
        try {
          this.planningSince = Date.now();
          const steps = await this.plan();
          action = steps[0]!;
          this.planQueue = steps.slice(1);
        } catch (e) {
          this.log('warn', `planner error: ${(e as Error).message}`);
          this.jsonl.write('planner_error', { error: (e as Error).message });
          action = fallbackAction(countItem(this.bot, /_log$/));
          await sleep(5000);
        }
        this.planningSince = 0;
      }
      if (!this.running) break;
      const { result, interrupted } = await this.execute(action);
      if (this.planQueue.length && (interrupted || looksFailed(result))) {
        this.planNote = `plan stopped: step "${action.skill}" ${interrupted ? 'was interrupted' : 'failed'} (${result.slice(0, 120)}); dropped: ${this.planQueue.map((p) => p.skill).join(', ')}`;
        this.planQueue = [];
      }
    }
  }

  private async plan(): Promise<PlannedAction[]> {
    const bot = this.bot!;
    const { provider, tier } = this.deps.llm.forTier(this.tier);
    const obs = buildObservation({
      bot,
      name: this.name,
      tier: this.tier,
      memory: this.memory,
      scanRadius: this.deps.config.bot.scanRadius,
      temp: this.temp,
      seasonsEnabled: this.deps.seasons.enabled,
      heard: this.chat.recent(),
      recentResults: this.recentResults,
      interruptedBy: this.interruptedBy,
      planNote: this.planNote,
      shoutCooldown: shoutCooldownLeft(this.name, this.deps.config.shout.cooldownSeconds),
      chatRange: this.deps.config.chatRange,
      silentSeconds: (Date.now() - this.lastSpokeAt) / 1000,
    });
    this.interruptedBy = undefined;
    this.planNote = undefined;
    this.chat.takeUnread();
    const system = systemPrompt(this.tier, this.name, this.deps.config.chatRange, this.deps.config.shout);
    const ask = this.tier === 'smart' ? 'Make your plan (1-5 steps).' : 'Choose your next action.';
    const messages: ChatMessage[] = [{ role: 'user', content: `${obs}\n\n${ask}` }];
    const started = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await provider.complete({ system, messages, maxTokens: tier.maxTokens, temperature: tier.temperature, model: tier.model });
      const parsed = parsePlan(res.text, this.tier);
      this.jsonl.write('decision', {
        obsHash: shortHash(obs),
        attempt,
        ms: Date.now() - started,
        raw: res.text.slice(0, 600),
        ok: parsed.ok,
        error: parsed.ok ? undefined : parsed.error,
      });
      if (parsed.ok) {
        if (parsed.say && this.bot) {
          this.bot.chat(parsed.say);
          this.lastSpokeAt = Date.now();
          this.log('info', `says: ${parsed.say}`);
          this.jsonl.write('said', { text: parsed.say });
        }
        if (parsed.steps.length > 1) this.log('info', `plan: ${parsed.steps.map((p) => p.skill).join(' -> ')} — ${parsed.thought}`);
        return parsed.steps;
      }
      messages.push({ role: 'assistant', content: res.text.slice(0, 1000) }, { role: 'user', content: retryPrompt(parsed.error) });
    }
    return [fallbackAction(countItem(bot, /_log$/))];
  }

  private async execute(action: PlannedAction): Promise<{ result: string; interrupted: boolean }> {
    const ac = new AbortController();
    this.skillAbort = ac;
    this.currentSkill = action.skill;
    const timeoutMs = this.deps.config.bot.skillTimeoutSeconds * 1000;
    const timer = setTimeout(() => ac.abort(new TimeoutError()), timeoutMs);
    const started = Date.now();
    let result: string;
    this.log('info', `${action.skill} ${JSON.stringify(action.args)} — ${action.thought}`);
    try {
      // Hard stop: even if a skill ignores its abort signal, the bot moves on shortly after the timeout.
      const hardStop = new Promise<never>((_, reject) => {
        const onAbort = (): void => {
          setTimeout(() => reject(ac.signal.reason ?? new TimeoutError()), 5_000);
        };
        if (ac.signal.aborted) onAbort();
        else ac.signal.addEventListener('abort', onAbort, { once: true });
      });
      hardStop.catch(() => undefined);
      result = await Promise.race([runSkill(this.makeCtx(ac.signal), action.skill, action.args), hardStop]);
    } catch (e) {
      if (ac.signal.aborted) {
        result = ac.signal.reason instanceof TimeoutError ? `timed out after ${timeoutMs / 1000}s` : `interrupted (${this.interruptedBy ?? 'event'})`;
      } else {
        result = `failed: ${(e as Error).message}`;
      }
      try {
        this.bot?.pathfinder.stop();
        void this.bot?.collectBlock?.cancelTask().catch(() => undefined);
      } catch {
        /* ignore */
      }
    } finally {
      clearTimeout(timer);
      this.skillAbort = undefined;
      this.currentSkill = undefined;
    }
    const line = `${action.skill}(${JSON.stringify(action.args)}) -> ${result}`;
    this.recentResults.push(line.slice(0, 300));
    while (this.recentResults.length > 6) this.recentResults.shift();
    this.log('info', `  => ${result}`);
    this.jsonl.write('skill', { skill: action.skill, args: action.args, thought: action.thought, result, ms: Date.now() - started });
    if ((action.skill === 'say' || action.skill === 'shout') && !looksFailed(result)) this.lastSpokeAt = Date.now();
    const lesson = lessonFrom(action.skill, action.args, result);
    if (lesson && this.memory.learn(lesson)) this.jsonl.write('lesson', { lesson });
    return { result, interrupted: ac.signal.aborted };
  }
}
