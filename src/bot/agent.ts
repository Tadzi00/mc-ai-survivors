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
import { countItem, digBunker, findBlocks, fmtPos, goSurface, gotoNear, gotoXZ, HOSTILE_MOBS, isTreeLog, MAN_MADE_RE, ManMadeIndex, enableDoorPathing, nearManMade, v3, type Vec3 } from '../skills/helpers.js';
import { doorDigPenalty } from './doors.js';
import { runSkill } from '../skills/index.js';
import { attackSkill, eatSkill, sleepSkill } from '../skills/impl/survival.js';
import { heatRoomSkill, placeTorchSkill } from '../skills/impl/building.js';
import { JsonlLog, log, shortHash } from '../util/log.js';
import { AbortError, sleep, TimeoutError } from '../util/time.js';
import { fallbackAction, looksFailed, parsePlan, type PlannedAction } from './action.js';
import { shoutCooldownLeft, tryShout } from '../skills/impl/knowledge.js';
import { enableServerCrafting } from '../skills/impl/resources.js';
import type { CommandRunner } from '../rcon/rcon.js';
import { addLesson, cleanLesson, isLessonWorthy, lessonFrom, parseChestReport } from './memory.js';
import { looksLikeOrder, parseDirectCommand } from './orders.js';
import { classifyChat } from './chat.js';
import { ChatLog, HomeRegistry, ProtectedAreas, Roster } from './chat.js';
import { LESSON_CAP, Memory } from './memory.js';
import { buildObservation, fitObservation, inventorySummary } from './observation.js';
import { retryPrompt, systemPrompt } from './prompts.js';
import { chooseReflex, type Reflex, type ReflexState } from './reflexChoice.js';

const { pathfinder, Movements } = pathfinderPkg;

export interface AgentDeps {
  config: Config;
  llm: LLMRegistry;
  seasons: SeasonsApi;
  /** Positions of all bots in this orchestrator (shout range for bots out of entity view). */
  roster: Roster;
  /** Server console (RCON), used for server-side crafting. */
  rcon?: CommandRunner;
  /** Protected building areas from the bridge plugin. */
  protectedAreas?: ProtectedAreas;
  /** All bots' homes. */
  homes?: HomeRegistry;
}

export interface AgentEvents {
  onSpawn(agent: BotAgent): void;
  onDeath(agent: BotAgent, cause: string): void;
  onDisconnect(agent: BotAgent, reason: string): void;
}

/** Entity metadata index 0 is a bit field; bit 0x01 = on fire. */
const isOnFire = (flags: unknown): boolean => typeof flags === 'number' && (flags & 0x01) === 1;

const ARMOR_TIERS: Record<string, number> = { leather: 1, golden: 2, chainmail: 3, turtle: 4, iron: 4, diamond: 5, netherite: 6 };
function armorRank(name: string): number {
  return ARMOR_TIERS[name.split('_')[0]!] ?? 0;
}

/** Nearest standable spot within 6 blocks with 3 natural blocks below and a solid floor (for digBunker). */
function findBunkerSpot(bot: Bot): Vec3 | undefined {
  const base = bot.entity.position.floored();
  const natural = (p: Vec3): boolean => {
    const b = bot.blockAt(p);
    return !!b && b.boundingBox === 'block' && !MAN_MADE_RE.test(b.name) && bot.canDigBlock(b);
  };
  let best: Vec3 | undefined;
  let bestD = Infinity;
  for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) for (const dy of [0, 1, -1]) {
    const p = base.offset(dx, dy, dz);
    const free = (q: Vec3): boolean => bot.blockAt(q)?.boundingBox === 'empty' && bot.blockAt(q)?.name !== 'water' && bot.blockAt(q)?.name !== 'lava';
    if (!free(p) || !free(p.offset(0, 1, 0))) continue;
    if (![1, 2, 3].every((k) => natural(p.offset(0, -k, 0)))) continue;
    if (bot.blockAt(p.offset(0, -4, 0))?.boundingBox !== 'block') continue;
    const d = p.distanceTo(base);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

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
  // utilities (someone's base, useful to find again)
  ['crafting_table', (n) => n === 'crafting_table'],
  ['furnace', (n) => n === 'furnace' || n === 'smoker' || n === 'blast_furnace'],
  ['chest', (n) => n === 'chest' || n === 'barrel'],
  ['bed', (n) => n.endsWith('_bed')],
];
const ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit']);

const FACE_OFFSETS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;

/** Blocks the unstuck routine must never break (homes, utility, other bots' work). */
const NEVER_DIG = /door|_bed$|chest|barrel|crafting_table|furnace|smoker|torch|lantern|_sign$|lectern|glass|bedrock|_wool$|farmland|campfire/;

const BODY_COLD = new Set(['COLD', 'SHIVERING', 'HYPOTHERMIA']);

const PREY = ['cow', 'pig', 'sheep', 'chicken', 'rabbit'];
const PREY_LABELS = new Set(PREY.map((p) => `${p}s`));

const REFLEX_COOLDOWN_MS: Partial<Record<Reflex, number>> = {
  // failures (bad ground) must not re-fire every tick: each try interrupts the current action
  night_shelter: 45_000,
  hunt: 20_000,
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
  /** A teammate's HELP shout we may run to (assist reflex). */
  private helpCall:
    | { from: string; pos: { x: number; y: number; z: number }; at: number; checkedAt?: number }
    | undefined;
  /** Someone asked if we're alive: reply (as a shout) as soon as our shout cooldown allows. */
  private pendingAliveReply: { to: string; until: number; via: 'shout' | 'say' | 'whisper' } | undefined;
  /** For !think. */
  private lastThought = '';
  /** A step to run next regardless of the plan queue (player command). */
  private forcedStep: PlannedAction | undefined;
  /** Feet position of tonight's emergency bunker (cleared after leaving it in the morning). */
  private bunker: Vec3 | undefined;
  private readonly manMade = new ManMadeIndex();
  /** A player whose private message we're answering: the next "say" is whispered back to them. */
  private replyTo: string | undefined;
  /** A player's instruction that stays at the top of the observation for a while. */
  /** Player's standing order; persisted in memory so a restart doesn't forget it. */
  private get order(): { from: string; text: string; until: number } | undefined {
    return this.memory.data.order;
  }
  private set order(o: { from: string; text: string; until: number } | undefined) {
    this.memory.setOrder(o);
  }
  private lastConclusionAt = 0;
  private lastWhisperAt = 0;
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
  private recentResults: string[] = [];
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
    const savedBunker = this.memory.place('bunker');
    if (savedBunker) this.bunker = v3(savedBunker.x, savedBunker.y, savedBunker.z);
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
      // No scaffolding: the pathfinder used to place dirt/cobblestone to climb or bridge and then dig it out
      // again a moment later (pointless place/break loops, wasted blocks). Walk around instead.
      moves.scafoldingBlocks = [];
      moves.allow1by1towers = false;
      if (this.deps.rcon && this.deps.config.bot.serverCrafting) enableServerCrafting(bot, this.name, this.deps.rcon);
      // Walk through doors (open, pass, close behind) instead of digging round them.
      enableDoorPathing(bot, moves);
      // Built blocks (glass, panes, planks, doors, beds, ...) are never broken while pathfinding, so a closed
      // house can only be entered through its door. (The exclusion cost below covers blocks NEXT to them.)
      for (const b of Object.values(bot.registry.blocksByName)) {
        if (MAN_MADE_RE.test(b.name)) moves.blocksCantBreak.add(b.id);
      }
      // Never dig through our own (or a known) shelter: breaking blocks near home costs a fortune.
      moves.exclusionAreasBreak.push((block: { name: string; position: Vec3 }) => {
        const p = block.position;
        // never dig through buildings: protected areas, man-made blocks, or blocks touching them
        // (set lookups via the periodically refreshed index: per-candidate block reads timed out paths)
        if (this.deps.protectedAreas?.contains(p)) return 1000;
        if (this.manMade.touches(p)) return 1000;
        // any bot's home (not just ours): a visitor must use the door too
        const homes = [this.memory.place('home'), ...(this.deps.homes?.all() ?? [])];
        for (const home of homes) {
          if (home && Math.abs(p.x - home.x) <= 4 && Math.abs(p.z - home.z) <= 4 && p.y >= home.y - 1 && p.y <= home.y + 4) return 1000;
        }
        return 0;
      });
      // Prefer doors: digging near a known door costs extra, so the pathfinder walks round to the door
      // unless that detour is much longer (see bot/doors.ts). The pathfinder only uses the break-exclusion
      // hook as an allowed/forbidden switch, so the penalty is added to its dig cost instead.
      const m = moves as unknown as { safeOrBreak: (block: { safe?: boolean; position: Vec3 }, toBreak: Vec3[]) => number };
      const safeOrBreak = m.safeOrBreak.bind(moves);
      m.safeOrBreak = (block, toBreak) => {
        const cost = safeOrBreak(block, toBreak);
        if (block.safe || cost >= 100) return cost;
        return cost + doorDigPenalty(block.position, this.manMade.doors);
      };
      bot.pathfinder.setMovements(moves);
      bot.pathfinder.thinkTimeout = 10_000; // default 5 s gave up too early in dense terrain
      (bot.pathfinder as unknown as { searchRadius: number }).searchRadius = 40; // impossible targets fail fast (not in the typings)
      this.manMade.refresh(bot);
      this.timers.push(setInterval(() => {
        if (this.bot?.entity) this.manMade.refresh(this.bot);
      }, 5_000));
      this.running = true;
      this.lastHealth = bot.health;
      this.log('info', `spawned at ${bot.entity.position.floored().toString()}`);
      this.jsonl.write('spawn', { tier: this.tier, pos: bot.entity.position });
      this.events.onSpawn(this);
      this.timers.push(setInterval(() => void this.reflexTick(), this.deps.config.bot.reflexIntervalMs));
      this.timers.push(setInterval(() => this.idleWatchdog(), 10_000));
      this.timers.push(setInterval(() => this.scanDiscoveries(), 15_000));
      this.timers.push(
        setInterval(() => {
          try {
            this.helpCheckTick();
          } catch (e) {
            this.log('warn', `helpCheckTick: ${(e as Error).message}`);
            this.jsonl.write('error', { where: 'helpCheckTick', error: (e as Error).message });
          }
        }, 3_000),
      );
      this.timers.push(setInterval(() => void this.equipBestArmor(), 10_000));
      bot.on('playerCollect', (collector) => {
        if (collector === bot.entity) setTimeout(() => void this.equipBestArmor(), 500);
      });
      bot.on('whisper', (username, message) => void this.onWhisper(username, String(message)));
      this.timers.push(setInterval(() => void this.unstickTick(), 1_000));
      this.timers.push(setInterval(() => void this.temperatureTick(), this.deps.config.bot.temperatureCheckSeconds * 1000));
      void this.temperatureTick();
      void this.plannerLoop();
    });

    bot.on('chat', (username, message) => {
      if (/^Test/.test(username) && !/^Test/.test(this.name)) return; // ignore harness bots
      // Unknown speaker position: a shout with coordinates in it ("HELP! ... at x y z") tells us where it is,
      // so far-away shouts are dropped by distance instead of being assumed in range.
      const coords = /(-?\d{1,7})[ ,]+(-?\d{1,4})[ ,]+(-?\d{1,7})/.exec(message);
      const speakerPos =
        bot.players[username]?.entity?.position ??
        this.deps.roster.get(username) ??
        (message.startsWith('[SHOUT]') && coords ? { x: Number(coords[1]), y: Number(coords[2]), z: Number(coords[3]) } : undefined);
      const ranges = { say: this.deps.config.chatRange, shout: this.deps.config.shout.range };
      if (this.chat.offer(this.name, username, message, bot.entity?.position, speakerPos, ranges)) {
        this.jsonl.write('heard', { from: username, text: message });
        this.rememberShout(username, message, speakerPos);
        // "Surv_03, are you alive?" in normal chat -> answer in normal chat.
        if (!message.startsWith('[SHOUT]') && new RegExp(`\\b${this.name}\\b`, 'i').test(message) && /alive\?|where are you|are you ok/i.test(message)) {
          this.pendingAliveReply = { to: username, until: Date.now() + 30_000, via: 'say' };
          this.helpCheckTick();
        }
        // "Stored 15 cobblestone in the chest at x y z" from someone nearby -> update our chest knowledge.
        const report = parseChestReport(message);
        if (report) this.memory.adjustChest(report.pos, report.items, report.sign, username);
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
        this.wakePlanner(this.temp?.stage === 'HYPOTHERMIA' ? 'freezing damage' : 'hurt');
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
    this.deps.homes?.set(this.name, undefined);
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
      protectedAreas: this.deps.protectedAreas,
      homes: this.deps.homes,
    };
  }

  // ---------------------------------------------------------------- seasons
  private async temperatureTick(): Promise<void> {
    const bot = this.bot;
    if (!this.running || !bot?.entity || !this.deps.seasons.enabled) return;
    const p = bot.entity.position;
    this.temp = await this.deps.seasons.tempForPlayer(this.name, p.x, p.y, p.z).catch(() => undefined);
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
    // Trees (natural logs only, not house walls), so gather can walk back to wood later.
    const tree = findBlocks(bot, all.filter((n) => /_log$/.test(n) && !n.startsWith('stripped')), 32, 24).find((b) => isTreeLog(bot, b));
    if (tree && this.memory.discover('trees', tree.position)) this.jsonl.write('discovery', { what: 'trees', pos: tree.position });
    for (const e of Object.values(bot.entities)) {
      if (!e.name || !ANIMALS.has(e.name) || !e.position || e.position.distanceTo(bot.entity.position) > 32) continue;
      if (this.memory.discover(`${e.name}s`, e.position)) this.jsonl.write('discovery', { what: e.name, pos: e.position });
    }
  }

  /** Server death messages are global: learn who died, how, and (if known) where. */
  private noteDeathOfOther(msg: string): void {
    const m = /^(\w{3,16}) (was |died|drowned|fell|burned|froze|hit the ground|tried to swim|walked into|starved|suffocated|blew up|withered)/.exec(msg);
    if (!m || m[1] === this.name) return;
    if (/^Test/.test(m[1]!) && !/^Test/.test(this.name)) return; // harness bots (scripts/*harness.mjs) are not part of the world
    this.forgetAbout(m[1]!, false);
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
    // Someone asks whether WE are alive -> answer (scripted, so it happens even mid-task).
    if (new RegExp(`\\b${this.name}\\b`, 'i').test(text) && /alive\?|where are you|are you ok/i.test(text) && !/^\S+: alive at/i.test(text)) {
      this.pendingAliveReply = { to: from, until: Date.now() + 70_000, via: 'shout' };
      this.jsonl.write('alive_asked', { from });
      this.helpCheckTick(); // answer right away; the 3 s timer only retries
      return;
    }
    // The bot we're helping answered our check-in.
    if (this.helpCall && from === this.helpCall.from && /alive/i.test(text)) {
      if (/safe|fine|no help/i.test(text)) {
        this.helpCall = undefined;
        this.log('info', `${from} says they are safe; stopping help`);
      } else {
        this.helpCall = { from, pos, at: Date.now() };
        this.log('info', `${from} is alive at ${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}; still going`);
      }
      return;
    }
    if (/help/i.test(text) && from !== this.name) {
      this.helpCall = { from, pos, at: Date.now() };
      this.log('info', `heard ${from} call for help at ${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`);
    }
    if (/village|town|base|meet/i.test(text) && !this.memory.place('village')) {
      this.memory.setPlace('village', { ...pos, note: `shouted by ${from}` });
      this.memory.learn(`${from} shouted the village location: ${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`);
    } else if (!/help|attack/i.test(text)) {
      this.memory.discover(`spot shouted by ${from}: ${text.slice(0, 40)}`, pos);
    }
  }

  /**
   * Every 3 s: (1) helper side: 30 s after a help call, shout a check-in "X, are you alive?"; if no answer
   * within 35 s more, give up (they may be dead). (2) caller side: answer a check-in as soon as the shout
   * cooldown allows, with position, health and whether help is still needed.
   */
  private helpCheckTick(): void {
    const bot = this.bot;
    if (!this.running || !bot?.entity) return;
    const now = Date.now();
    const call = this.helpCall;
    if (call) {
      if (!call.checkedAt && now - call.at > 30_000) {
        if (!tryShout(bot, this.name, `${call.from}, are you alive? Where are you?`, this.deps.config.shout, true)) {
          call.checkedAt = now;
          this.jsonl.write('help_checkin', { to: call.from });
        }
      } else if (call.checkedAt && now - call.checkedAt > 60_000 && call.at < call.checkedAt) {
        this.helpCall = undefined;
        this.memory.learn(`${call.from} called for help but did not answer my check-in (maybe dead)`);
        this.log('info', `${call.from} did not answer; giving up the rescue`);
      }
    }
    const ask = this.pendingAliveReply;
    if (ask) {
      if (now > ask.until) {
        this.pendingAliveReply = undefined;
        return;
      }
      const p = bot.entity.position;
      const danger = this.hostilesWithin(12).length > 0;
      const text = `${ask.to}: alive at ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}, health ${Math.round(bot.health)}, ${danger ? 'still need help' : 'safe now'}`;
      if (ask.via === 'whisper') bot.whisper(ask.to, text);
      else if (ask.via === 'say') bot.chat(text);
      else if (tryShout(bot, this.name, text, this.deps.config.shout, true)) return; // (only fails on length)
      this.pendingAliveReply = undefined;
      this.jsonl.write('alive_reply', { to: ask.to, via: ask.via });
    }
  }

  /** Puts on any armor piece in the inventory that is better than what is worn (protection tier). */
  private async equipBestArmor(): Promise<void> {
    const bot = this.bot;
    if (!this.running || !bot?.entity) return;
    const SLOTS: Array<[RegExp, number, 'head' | 'torso' | 'legs' | 'feet']> = [
      [/_helmet$/, 5, 'head'],
      [/_chestplate$/, 6, 'torso'],
      [/_leggings$/, 7, 'legs'],
      [/_boots$/, 8, 'feet'],
    ];
    for (const [re, slot, dest] of SLOTS) {
      const worn = bot.inventory.slots[slot];
      const best = bot.inventory
        .items()
        .filter((i) => re.test(i.name))
        .sort((a, b) => armorRank(b.name) - armorRank(a.name))[0];
      if (best && armorRank(best.name) > (worn ? armorRank(worn.name) : 0)) {
        try {
          await bot.equip(best, dest);
          this.jsonl.write('armor', { equipped: best.name, replaced: worn?.name ?? null });
          this.log('info', `put on ${best.name}${worn ? ` (was ${worn.name})` : ''}`);
        } catch {
          /* try again next round */
        }
      }
    }
  }

  // ---------------------------------------------------------------- /msg commands from players

  /**
   * Private messages (/msg <bot> ...) from humans: "!think", "!status", "!forget <text>"; anything else is a
   * direct message the bot always hears and reacts to right away. Other bots' whispers are ignored.
   */
  private async onWhisper(from: string, message: string): Promise<void> {
    const bot = this.bot;
    if (!bot || from === this.name || from.startsWith(this.deps.config.population.namePrefix)) return;
    const msg = message.trim();
    if (!msg.startsWith('!')) this.lastWhisperAt = Date.now();
    const reply = (t: string): void => {
      for (const part of t.match(/.{1,230}(\s|$)/g) ?? [t]) bot.whisper(from, part.trim());
    };
    if (/^!think\b/i.test(msg)) {
      const plan = this.planQueue.map((p) => `${p.skill} ${JSON.stringify(p.args)}`).join(' -> ');
      reply(`Thought: ${this.lastThought || '(none yet)'}`);
      reply(`Doing: ${this.currentSkill ?? (this.reflexBusy ? 'a reflex' : this.planningSince ? 'thinking...' : 'nothing')}${plan ? ` | then: ${plan}` : ''}`);
      reply(`Goal: ${this.memory.data.goal ?? '(none)'}${this.helpCall ? ` | helping ${this.helpCall.from}` : ''}`);
      return;
    }
    if (/^!status\b/i.test(msg)) {
      const p = bot.entity.position;
      reply(`HP ${Math.round(bot.health)}/20, food ${bot.food}/20, at ${fmtPos(p)}, ${this.tier}`);
      reply(`Inventory: ${inventorySummary(bot).slice(0, 220)}`);
      return;
    }
    if (/^!home\b/i.test(msg)) {
      // "!home x y z", else your position if the bot can see you, else its own.
      const xyz = /^!home\s+(-?\d+)[\s,]+(-?\d+)[\s,]+(-?\d+)/i.exec(msg);
      const pos = xyz ? v3(Number(xyz[1]), Number(xyz[2]), Number(xyz[3])) : bot.players[from]?.entity?.position ?? bot.entity.position;
      this.memory.setPlace('home', { x: pos.x, y: pos.y, z: pos.z, note: `set by ${from}` });
      delete this.memory.data.places.doorway;
      this.memory.learn(`${from} gave me a home at ${fmtPos(pos)}`);
      reply(`OK, my home is now ${fmtPos(pos)}.`);
      return;
    }
    const teach = /^!teach\s+(.+)$/i.exec(msg);
    if (teach) {
      const fact = teach[1]!.trim().slice(0, 150);
      this.memory.learn(`Taught by ${from}: ${fact}`);
      this.jsonl.write('taught', { from, fact });
      reply(`Got it, I'll remember: ${fact}`);
      return;
    }
    // Long answers are sent a line every 0.4 s (the server kicks for chat spam) and capped at 16 lines.
    const replyLines = (lines: string[]): void => {
      const out = lines.flatMap((l) => l.match(/.{1,230}(\s|$)/g)?.map((x) => x.trim()) ?? [l]).slice(0, 16);
      out.forEach((l, i) => setTimeout(() => this.bot?.whisper(from, l), i * 400));
    };
    if (/^!lessons?\b/i.test(msg)) {
      const ls = this.memory.data.lessons ?? [];
      replyLines(ls.length ? [`Lessons ${ls.length}/${LESSON_CAP} (!forget <number> drops one):`, ...ls.map((l, i) => `[${i + 1}] ${l}`)] : ['I have no lessons yet.']);
      return;
    }
    const finds = /^!finds?\b\s*(.*)$/i.exec(msg);
    if (finds) {
      const me = bot.entity.position;
      const kind = finds[1]!.trim().toLowerCase();
      const list = (this.memory.data.discoveries ?? [])
        .filter((d) => !kind || d.what.toLowerCase().includes(kind))
        .map((d) => ({ d, dist: Math.hypot(d.x - me.x, d.z - me.z) }))
        .sort((a, b) => a.dist - b.dist);
      replyLines(
        list.length
          ? [`${list.length} finds${kind ? ` matching "${kind}"` : ''}, nearest first:`, ...list.slice(0, 14).map(({ d, dist }) => `${d.what} ${d.x},${d.y},${d.z} (${Math.round(dist)}m)`)]
          : [`No finds${kind ? ` matching "${kind}"` : ''}.`],
      );
      return;
    }
    if (/^!(memory|mem)\b/i.test(msg)) {
      const d = this.memory.data;
      const lines: string[] = [];
      const places = Object.entries(d.places).map(([k, p]) => `${k} ${p.x},${p.y},${p.z}`);
      lines.push(`Places: ${places.join('; ') || 'none'}`);
      if (d.goal) lines.push(`Goal: ${d.goal}`);
      if (d.order && d.order.until > Date.now()) lines.push(`Order from ${d.order.from} (${Math.round((d.order.until - Date.now()) / 60_000)} min left): ${d.order.text}`);
      for (const c of Object.values(d.storage ?? {}).slice(0, 4)) {
        const items = Object.entries(c.items).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ');
        lines.push(`Chest ${c.x},${c.y},${c.z} (per ${c.by}): ${items || 'empty'}`);
      }
      const kinds = new Map<string, number>();
      for (const x of d.discoveries ?? []) kinds.set(x.what.split(':')[0]!, (kinds.get(x.what.split(':')[0]!) ?? 0) + 1);
      lines.push(`Finds (${(d.discoveries ?? []).length}): ${[...kinds].map(([k, n]) => `${k} x${n}`).join(', ') || 'none'} - !finds <kind> for spots`);
      lines.push(`Lessons: ${(d.lessons ?? []).length}/${LESSON_CAP} - !lessons to read them`);
      if (d.shelters?.length) lines.push(`Shelters built: ${d.shelters.length}`);
      if (d.notes.length) lines.push(`Notes: ${d.notes.slice(-3).join(' | ')}`);
      replyLines(lines);
      return;
    }
    const fNum = /^!forget\s+#?\[?(\d+)\]?\s*$/i.exec(msg);
    if (fNum) {
      const gone = this.memory.forgetLesson(Number(fNum[1]));
      reply(gone ? `Forgot lesson [${fNum[1]}]: ${gone}` : `No lesson [${fNum[1]}] (see !lessons).`);
      return;
    }
    const f = /^!forget\s+(.+)$/i.exec(msg);
    if (f) {
      reply(this.forgetAbout(f[1]!.trim(), true));
      return;
    }
    if (/^!/.test(msg)) {
      reply('Commands: !think, !status, !memory, !lessons, !finds [kind], !home [x y z] (here or there becomes my home), !teach <fact>, !forget <text or lesson number>. Anything else is a message to me.');
      return;
    }
    this.chat.offerDirect(from, msg);
    this.jsonl.write('heard', { from, text: msg, direct: true });
    // Simple factual questions get an instant, correct answer from code (no model needed).
    if (/where (are|r) (you|u)|your (location|position|coords)|coordinates|alive\?|are you ok/i.test(msg)) {
      const p = bot.entity.position;
      const sky = bot.blockAt(p.offset(0, 1.6, 0))?.skyLight ?? 15;
      reply(`I'm at ${fmtPos(p)}${sky < 6 ? ' (underground)' : ''}, health ${Math.round(bot.health)}/20, food ${bot.food}/20.`);
    }
    if (looksLikeOrder(msg) || parseDirectCommand(msg, from)) {
      this.order = { from, text: msg.slice(0, 160), until: Date.now() + 15 * 60_000 };
    }
    // Common commands run right away, no model needed.
    const cmd = parseDirectCommand(msg, from);
    if (cmd) {
      reply(cmd.ack);
      // Direct commands: keep the order visible only briefly (in case a step fails); "stop" clears orders.
      this.order = cmd.steps[0]?.skill === 'wait' ? undefined : { from, text: msg.slice(0, 160), until: Date.now() + 90_000 };
      this.jsonl.write('order', { from, text: msg, steps: cmd.steps.map((s) => s.skill) });
      this.planQueue = cmd.steps.slice(1);
      this.forcedStep = cmd.steps[0];
      if (this.skillAbort && this.currentSkill && !this.reflexBusy) {
        this.interruptedBy = `order from ${from}`;
        this.skillAbort.abort();
      }
      this.lastPlanAt = 0;
      return;
    }
    // React now: stop the current action and re-plan with the message in view.
    this.planQueue = [];
    this.replyTo = from;
    this.planNote = `${from} sent you a PRIVATE message: "${msg.slice(0, 160)}". Answer THAT message directly in "say" (it is sent privately to ${from}); if it is an instruction, follow it; if it teaches you something, also write it in "learned"`;
    if (this.skillAbort && this.currentSkill && !this.reflexBusy) {
      this.interruptedBy = `message from ${from}`;
      this.skillAbort.abort();
    }
    this.lastPlanAt = 0;
  }

  /**
   * Removes everything mentioning `needle` from memory: notes, lessons, discoveries, places, heard chat,
   * plan, help call, goal. `manual` = player command (wipes all mentions); otherwise only stale calls for
   * help / shouted spots from a bot that just died are dropped (its death lesson is kept).
   */
  private forgetAbout(needle: string, manual: boolean): string {
    const n = needle.toLowerCase();
    const has = (t: string | undefined | null): boolean => !!t && t.toLowerCase().includes(n);
    let count = 0;
    const d = this.memory.data;
    if (this.helpCall && has(this.helpCall.from)) {
      this.helpCall = undefined;
      count++;
    }
    count += this.chat.forget((h) => has(h.from) || (manual && has(h.text)));
    const before = (d.discoveries ?? []).length;
    d.discoveries = (d.discoveries ?? []).filter((x) => !has(x.what));
    count += before - d.discoveries.length;
    if (manual) {
      const nb = d.notes.length;
      d.notes = d.notes.filter((x) => !has(x));
      const lb = (d.lessons ?? []).length;
      d.lessons = (d.lessons ?? []).filter((x) => !has(x));
      count += nb - d.notes.length + lb - d.lessons.length;
      for (const [k, p] of Object.entries(d.places)) {
        if (has(k) || has(p.note)) {
          delete d.places[k];
          count++;
        }
      }
      if (has(d.goal)) {
        d.goal = null;
        count++;
      }
      if (this.planQueue.length || this.planNote) count++;
      this.planQueue = [];
      this.planNote = undefined;
      this.recentResults = this.recentResults.filter((r) => !has(r));
    }
    this.memory.save();
    if (manual) this.jsonl.write('forget', { needle, removed: count });
    return `Forgot ${count} thing(s) about "${needle}".`;
  }

  /**
   * Mentor a newborn: hand over home/village, utilities (crafting table, chest + contents, furnace), recent
   * finds and best lessons (in code, reliable), and whisper a welcome summary (visible to players).
   */
  mentor(student: BotAgent): void {
    const m = this.memory;
    const lines: string[] = [];
    const home = m.place('home') ?? m.place('village');
    if (home) {
      student.memory.setPlace('village', { ...home, note: `${this.name}'s home` });
      lines.push(`our home is at ${home.x} ${home.y} ${home.z}`);
    }
    for (const k of ['crafting_table', 'chest', 'furnace']) {
      const p = m.place(k);
      if (!p) continue;
      student.memory.setPlace(k, p);
      lines.push(`${k.replace('_', ' ')} at ${p.x} ${p.y} ${p.z}${p.note ? ` (${p.note})` : ''}`);
    }
    for (const d of (m.data.discoveries ?? []).slice(-12)) student.memory.discover(d.what, d);
    for (const c of Object.values(m.data.storage ?? {})) student.memory.setChest(c, c.items, this.name);
    const lessons = (m.data.lessons ?? []).filter((l) => !/^DEATH/.test(l)).slice(-8);
    for (const l of lessons) student.memory.learn(`From ${this.name}: ${l.replace(/^Taught by \w+: /, '')}`);
    student.memory.learn(`${this.name} is my mentor; ask them when unsure`);
    this.jsonl.write('mentor', { student: student.name, shared: lines.length, lessons: lessons.length });
    this.log('info', `mentoring ${student.name}: ${lines.length} places, ${lessons.length} lessons`);
    const text = `Welcome ${student.name}! ${lines.join('; ') || 'we have no base yet'}. ${lessons.length ? `Tips: ${lessons.slice(0, 3).join(' | ')}` : ''}`;
    for (const part of text.match(/.{1,230}(\s|$)/g) ?? [text]) this.bot?.whisper(student.name, part.trim());
  }

  private inventoryCounts(): Map<string, number> {
    const m = new Map<string, number>();
    for (const i of this.bot?.inventory.items() ?? []) m.set(i.name, (m.get(i.name) ?? 0) + i.count);
    return m;
  }

  /** "+14 jungle_log, -4 oak_planks" (top 5 changes), or '' if nothing changed. */
  private inventoryDelta(before: Map<string, number>): string {
    const after = this.inventoryCounts();
    const names = new Set([...before.keys(), ...after.keys()]);
    const changes: Array<[string, number]> = [];
    for (const n of names) {
      const d = (after.get(n) ?? 0) - (before.get(n) ?? 0);
      if (d !== 0) changes.push([n, d]);
    }
    changes.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    return changes.slice(0, 5).map(([n, d]) => `${d > 0 ? '+' : ''}${d} ${n}`).join(', ');
  }

  /** Snapshot for state/status.json (what this bot is up to right now). */
  status(): Record<string, unknown> {
    const bot = this.bot;
    const p = bot?.entity?.position;
    return {
      name: this.name,
      tier: this.tier,
      pos: p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null,
      health: bot ? Math.round(bot.health) : null,
      food: bot?.food ?? null,
      doing: this.currentSkill ?? (this.reflexBusy ? 'reflex' : this.planningSince ? 'thinking' : 'idle'),
      plan: this.planQueue.map((s) => s.skill),
      lastThought: this.lastThought,
      goal: this.memory.data.goal,
      home: this.memory.place('home') ?? null,
      bed: this.memory.place('bed') ?? null,
      bunkered: !!this.bunker,
      body: this.temp?.bodyC !== undefined ? { c: this.temp.bodyC, stage: this.temp.stage } : null,
      lessons: (this.memory.data.lessons ?? []).length,
    };
  }

  /** "You failed X 2+ times in a row - why?" so the model draws a conclusion instead of looping. */
  private repeatedFailureNote(): string | undefined {
    const last = this.recentResults.slice(-3);
    if (last.length < 2) return undefined;
    const key = (r: string): string => r.split(' -> ')[0] ?? r;
    const tail = last[last.length - 1]!;
    const same = last.filter((r) => key(r) === key(tail) && looksFailed(r.split(' -> ').slice(1).join(' -> '))).length;
    if (same < 2) return undefined;
    return `${key(tail)} failed ${same} times in a row. Stop repeating it. Think WHY (where are you? underground or outside?
 time of day? tools?) and write your conclusion in "learned", then try something different`;
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
    this.deps.homes?.set(this.name, this.memory.place('home'));
    if (this.unsticking) return;
    // Fighting/fleeing stands still on purpose (pvp keeps the pathfinder "moving"): never "unstick" then,
    // that used to stop the pathfinder and end the fight.
    if (!bot.pathfinder.isMoving() || bot.isSleeping || this.reflexBusy || bot.pvp.target || this.currentSkill === 'attack') {
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
        if (this.deps.protectedAreas?.contains(b.position) || nearManMade(bot, b.position, 1)) continue;
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

  private nearestPrey(maxDist = 48): Entity | undefined {
    const bot = this.bot!;
    return Object.values(bot.entities)
      .filter((e) => !!e.name && PREY.includes(e.name) && !!e.position && e.position.distanceTo(bot.entity.position) <= maxDist)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
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
      nightExposed: (() => {
        const t = bot.time.timeOfDay;
        const night = t >= 12_800 && t <= 23_000;
        const sky = bot.blockAt(bot.entity.position.offset(0, 1.6, 0))?.skyLight ?? 0;
        const wet = ['water', 'bubble_column'].includes(feet?.name ?? '') || ['water', 'bubble_column'].includes(head?.name ?? '');
        // never start digging while in water: the drowning reflex can't run while this one does
        return this.deps.config.bot.nightShelter && night && !wet && !this.bunker && sky >= 13 && !this.planQueue.some((p) => p.thought.startsWith('order from'));
      })(),
      bunkeredAtDay: !!this.bunker && bot.time.timeOfDay < 12_000,
      preyKnown: this.nearestPrey() !== undefined || (this.memory.data.discoveries ?? []).some((d) => PREY_LABELS.has(d.what)),
      helpCall:
        this.helpCall && Date.now() - this.helpCall.at < 90_000
          ? { distance: bot.entity.position.distanceTo(bot.entity.position.clone().set(this.helpCall.pos.x, this.helpCall.pos.y, this.helpCall.pos.z)) }
          : undefined,
      hasWeapon: bot.inventory.items().some((i) => /_sword$|_axe$/.test(i.name)),
      isNight: bot.time.timeOfDay >= 12_600 && bot.time.timeOfDay <= 23_000,
      isSleeping: bot.isSleeping,
      bedKnown: !!this.memory.place('bed'),
      // Cold = the air is freezing OR our body is already getting cold (shivering/hypothermia).
      cold:
        t && this.deps.seasons.enabled
          ? (!t.comfortable && t.tempC < cfg.coldThresholdC) || BODY_COLD.has(t.stage ?? '')
          : undefined,
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
    const timer = setTimeout(() => ac.abort(), choice === 'fight' ? 60_000 : ['assist', 'hunt', 'night_shelter', 'leave_bunker'].includes(choice) ? 90_000 : 25_000);
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
      case 'assist': {
        const call = this.helpCall;
        if (!call) return 'no help call';
        this.jsonl.write('assist', { to: call.from, pos: call.pos });
        bot.setControlState('sprint', true);
        try {
          await gotoNear(ctx, call.pos.x, call.pos.y, call.pos.z, 3, 45_000).catch(() => undefined);
        } finally {
          bot.setControlState('sprint', false);
        }
        const d = bot.entity.position.distanceTo(bot.entity.position.clone().set(call.pos.x, call.pos.y, call.pos.z));
        if (d <= 6 || Date.now() - call.at > 90_000) {
          this.helpCall = undefined;
          if (d <= 6) bot.chat(`${call.from}, I'm here to help!`);
        }
        return d <= 6 ? `reached ${call.from}` : `running to ${call.from}, ${Math.round(d)}m left`;
      }
      case 'hunt': {
        // Nearest visible prey, else the nearest remembered herd; attackSkill walks there and fights.
        const prey = this.nearestPrey();
        let target = prey?.name;
        if (!target) {
          const me = bot.entity.position;
          const herd = (this.memory.data.discoveries ?? [])
            .filter((d) => PREY_LABELS.has(d.what))
            .sort((p, q) => Math.hypot(p.x - me.x, p.z - me.z) - Math.hypot(q.x - me.x, q.z - me.z))[0];
          target = herd?.what.replace(/s$/, '');
        }
        if (!target) return 'no prey known';
        const r = await attackSkill(ctx, { target });
        // pick up the drops lying where it died
        await sleep(600, signal).catch(() => undefined);
        const drop = Object.values(bot.entities).find((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 8);
        if (drop) await gotoNear(ctx, drop.position.x, drop.position.y, drop.position.z, 0, 6_000).catch(() => undefined);
        return `hunted ${target}: ${r}`;
      }
      case 'night_shelter': {
        const home = this.memory.place('home');
        if (home && bot.entity.position.distanceTo(bot.entity.position.clone().set(home.x, home.y, home.z)) < 48) {
          bot.setControlState('sprint', true);
          await gotoNear(ctx, home.x, home.y, home.z, 1, 40_000).catch(() => undefined);
          bot.setControlState('sprint', false);
          const sky = bot.blockAt(bot.entity.position.offset(0, 1.6, 0))?.skyLight ?? 0;
          if (sky < 13) return 'night: went home';
        }
        let r = await digBunker(ctx);
        if (!r.feet) {
          // Ground here is bad (water, built blocks, cave below): find diggable ground nearby and try there.
          const spot = findBunkerSpot(bot);
          if (spot) {
            await gotoNear(ctx, spot.x, spot.y, spot.z, 0, 15_000).catch(() => undefined);
            r = await digBunker(ctx);
          }
        }
        if (r.feet) {
          this.bunker = r.feet;
          this.memory.setPlace('bunker', r.feet); // survives restarts (planner stays put until morning)
          this.memory.learn('At night in the open, dig 3 down and seal the top: zombies cannot reach you');
          this.jsonl.write('bunker', { pos: r.feet, result: r.why });
        }
        return `night: ${r.why}`;
      }
      case 'leave_bunker': {
        const r = await goSurface(ctx);
        this.bunker = undefined;
        delete this.memory.data.places.bunker;
        this.memory.save();
        return `morning: ${r}`;
      }
      case 'eat':
        return eatSkill(ctx);
      case 'warm_home': {
        const home = this.memory.place('home')!;
        if (bot.entity.position.distanceTo(bot.entity.position.clone().set(home.x, home.y, home.z)) > 3) {
          await gotoNear(ctx, home.x, home.y, home.z, 1, 18_000).catch(() => undefined);
          return 'went home to warm up';
        }
        return heatRoomSkill(ctx, 3); // add torches until the room is actually warm
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
      const inBunkerAtNight = !!this.bunker && (this.bot?.time.timeOfDay ?? 0) >= 12_000;
      if (this.reflexBusy || Date.now() - this.lastPlanAt < minInterval || !this.bot?.entity || (inBunkerAtNight && !this.forcedStep)) {
        await sleep(250);
        continue;
      }
      let action: PlannedAction;
      if (this.forcedStep) {
        action = this.forcedStep;
        this.forcedStep = undefined;
      } else if (this.planQueue.length) {
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
      planNote: this.planNote ?? this.repeatedFailureNote(),
      order: this.order && Date.now() < this.order.until ? this.order : undefined,
      shoutCooldown: shoutCooldownLeft(this.name, this.deps.config.shout.cooldownSeconds),
      chatRange: this.deps.config.chatRange,
      helpActive: !!this.helpCall,
      silentSeconds: (Date.now() - this.lastSpokeAt) / 1000,
    });
    this.interruptedBy = undefined;
    this.planNote = undefined;
    const obsText = fitObservation(obs, systemPrompt(this.tier, this.name, this.deps.config.chatRange, this.deps.config.shout).length);
    this.chat.takeUnread();
    const system = systemPrompt(this.tier, this.name, this.deps.config.chatRange, this.deps.config.shout);
    const ask = this.tier === 'smart' ? 'Make your plan (1-5 steps).' : 'Choose your next action.';
    const messages: ChatMessage[] = [{ role: 'user', content: `${obsText}\n\n${ask}` }];
    const started = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await provider.complete({ system, messages, maxTokens: tier.maxTokens, temperature: tier.temperature, model: tier.model });
      const parsed = parsePlan(res.text, this.tier);
      this.jsonl.write('decision', {
        obsHash: shortHash(obs),
        attempt,
        ms: Date.now() - started,
        raw: res.text.slice(0, 600),
        promptChars: system.length + messages.reduce((n, m) => n + m.content.length, 0),
        stats: res.stats,
        ok: parsed.ok,
        error: parsed.ok ? undefined : parsed.error,
      });
      if (parsed.ok) {
        this.lastThought = parsed.thought || parsed.steps[0]?.thought || '';
        const answeringTo = this.replyTo;
        this.replyTo = undefined;
        // At most one model conclusion per 3 minutes (it drew one almost every turn), unless a player
        // just taught it something in a private message.
        const taught = Date.now() - this.lastWhisperAt < 120_000;
        // The model picks what to drop. Only when it also saves a lesson, or names a lesson it calls wrong;
        // a full list with a new lesson and no choice falls back to the automatic eviction in addLesson.
        const lessons = this.memory.data.lessons ?? [];
        const canLearn =
          !!parsed.learned &&
          (taught || Date.now() - this.lastConclusionAt > 180_000) &&
          isLessonWorthy(parsed.learned) &&
          addLesson(lessons, `Conclusion: ${cleanLesson(parsed.learned)}`) !== lessons; // not a repeat
        if (parsed.forget !== undefined && (canLearn || !parsed.learned)) {
          const gone = this.memory.forgetLesson(parsed.forget);
          if (gone) {
            this.log('info', `forgot lesson [${parsed.forget}]: ${gone}`);
            this.jsonl.write('forget', { n: parsed.forget, text: gone });
          }
        }
        if (parsed.learned && (taught || Date.now() - this.lastConclusionAt > 180_000) && this.memory.conclude(parsed.learned)) {
          this.lastConclusionAt = Date.now();
          this.log('info', `concluded: ${parsed.learned}`);
          this.jsonl.write('conclusion', { text: parsed.learned });
        }
        if (parsed.say && this.bot) {
          if (answeringTo) this.bot.whisper(answeringTo, parsed.say);
          else this.bot.chat(parsed.say);
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
    const invBefore = this.inventoryCounts();
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
    // A player's order cut short by a reflex (eat, fight, surface...) resumes afterwards (up to 3 times),
    // instead of the model re-planning from the order text (it once took "go home" as "set home here").
    const resumes = (action as PlannedAction & { resumes?: number }).resumes ?? 0;
    if (/^interrupted \((?!order from|message from)/.test(result) && action.thought.startsWith('order from') && !this.forcedStep && resumes < 3) {
      this.forcedStep = { ...action, resumes: resumes + 1 } as PlannedAction;
      result += ' (will resume the order)';
    }
    // Tell the model what really changed (a gather that "timed out" may still have collected a lot).
    const delta = this.inventoryDelta(invBefore);
    if (delta && !result.includes(delta)) result = `${result}; inventory ${delta}`;
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
