import type { Block } from 'prismarine-block';
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
import { countItem, digBunker, findBlocks, fmtPos, goSurface, gotoNear, gotoXZ, HOSTILE_MOBS, isTreeLog, isSolid, MAN_MADE_RE, ManMadeIndex, LavaIndex, enableDoorPathing, walkStraight, emergencyHut, leaveHut, ALLOWED_DIGS, digKey, nearManMade, v3, type Vec3 } from '../skills/helpers.js';
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
import { addLesson, cleanLesson, isLessonWorthy, lessonFrom, lessonSimilarity, parseChestReport } from './memory.js';
import { looksLikeOrder, parseDirectCommand } from './orders.js';
import { classifyChat } from './chat.js';
import { ChatLog, HomeRegistry, ProtectedAreas, Roster } from './chat.js';
import { LESSON_CAP, Memory } from './memory.js';
import { Village } from './village.js';
import { scanRoom, shelterCheck } from '../skills/roomPlan.js';
import { readBookItem } from '../skills/bookText.js';
import { relevantKnowledge } from './knowledge.js';
import { answerFrom, askedFor, cleanBotName, isChatter, kindFromNews, saidRecently, topLessons, whatToShare } from './society.js';
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
  /** The one shared village. */
  village?: Village;
  /** All agents of this orchestrator (for meetings, mentoring, naming). Set by the lifecycle manager. */
  peers?: () => BotAgent[];
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
/** Skills that build or repair the home on purpose and may dig there (hollowing, doorways, crops). */
/** Skills a bot may run while dug in for the night (none of them walk away). */
const BUNKER_SAFE_SKILLS = new Set(['say', 'read_book', 'read_signs', 'write_book', 'remember', 'set_goal', 'eat', 'wait', 'check_temperature']);
const TOOL_TIER = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];
const HOME_BUILD_SKILLS = new Set(['build_shelter', 'extend_shelter', 'add_door', 'place_bed', 'farm']);
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
  private readonly lava = new LavaIndex();
  /** A player whose private message we're answering: the next "say" is whispered back to them. */
  private replyTo: string | undefined;
  /** A player's instruction that stays at the top of the observation for a while. */
  /**
   * Keeps the shared village in sync: founded at the remembered village/home if nobody founded it yet, and
   * a home the bot stands in (also one a player built) is added as a village building from its room plan.
   */
  private villageTick(): void {
    const v = this.deps.village;
    const bot = this.bot;
    if (!v || !bot?.entity) return;
    const home = this.memory.place('home');
    if (!v.center) {
      // The home (where beds and chests are) beats a spot the model once marked as "village".
      const seed = home ?? this.memory.place('village');
      if (seed) v.found(seed, this.name);
    }
    // Nothing to eat and no animals anywhere near: start the village field ourselves (the model kept
    // hunting cows that were not there until the bot starved). Hunger alone stops at half a heart on Normal,
    // so a bot that keeps out of trouble lives to the first harvest.
    if (!v.data.field && (bot.time.timeOfDay ?? 0) < 11_000 && !this.isApprentice() && !this.forcedStep && this.foodItemCount() === 0 &&
        bot.food <= 10 && !this.nearestPrey(48) && Date.now() - this.lastAutoField > 20 * 60_000) {
      this.lastAutoField = Date.now();
      this.planQueue = [];
      this.queueFirst({ skill: 'farm', args: { action: 'setup', crop: 'wheat' }, thought: 'order from myself: no food and no animals - start the village wheat field' });
      this.speakLines(['No animals left around here. Starting a wheat field by the water.']);
    }
    // The field needs looking after: by day, an idle bot near the village harvests, replants and bakes bread
    // every ~20 min (whoever gets there first; the time is shared in village.json).
    const field = v.data.field;
    if (field && (bot.time.timeOfDay ?? 0) < 11_000 && !this.isApprentice() && !this.forcedStep && !this.planQueue.length &&
        Date.now() - (field.tendedAt ?? 0) > 20 * 60_000 && Math.hypot(field.x - bot.entity.position.x, field.z - bot.entity.position.z) <= 64) {
      field.tendedAt = Date.now(); // claim it so not every bot goes
      this.queueFirst({ skill: 'farm', args: { action: 'tend', crop: 'wheat' }, thought: 'order from myself: tend the village field' });
    }
    // A bot with a book and quill in the village writes its knowledge into the library (daytime, idle,
    // at most every 30 min).
    const day = (bot.time.timeOfDay ?? 0) < 12_000;
    if (day && v.center && v.contains(bot.entity.position, 24) && countItem(bot, 'writable_book') > 0 && !this.isApprentice() &&
        !this.forcedStep && !this.planQueue.length && Date.now() - this.lastLibraryWrite > 30 * 60_000 && (this.memory.data.lessons ?? []).length >= 3) {
      this.lastLibraryWrite = Date.now();
      this.queueFirst({ skill: 'library_write', args: {}, thought: 'order from myself: add my knowledge to the village library' });
    }
    const vc = v.data.center;
    if (vc && vc.founder === this.name) this.news(`Village founded at ${vc.x} ${vc.y} ${vc.z}. Come live here!`, 'village-founded');
    const mine = this.memory.place('village');
    if (v.center && (!mine || mine.x !== v.center.x || mine.z !== v.center.z)) this.memory.setPlace('village', { ...v.center, note: 'the village' });
    this.adoptShelters();
    if (!home || v.buildingAt(home)) return;
    const me = bot.entity.position.floored();
    if (Math.hypot(me.x - home.x, me.z - home.z) > 6) return;
    const room = scanRoom(bot, me);
    if (!room || !room.cells.some((c) => Math.abs(c.x - home.x) <= 1 && Math.abs(c.z - home.z) <= 1)) return;
    v.addBuilding({ x0: room.x0 - 1, z0: room.z0 - 1, x1: room.x1 + 1, z1: room.z1 + 1, y0: room.y, door: room.doors[0], owner: this.name });
    this.log('info', `village: added my home room ${room.x0 - 1},${room.z0 - 1}..${room.x1 + 1},${room.z1 + 1}`);
  }

  /**
   * Any building with walls, a roof, 3+ blocks of headroom and a light inside counts as a shelter, also one a
   * player built. Lit rooms near us (found by their torches) are added to the village; a bot without a real
   * home moves into the one it stands in (or the nearest), so beds etc. can go there.
   */
  private adoptShelters(): void {
    const bot = this.bot;
    const v = this.deps.village;
    if (!bot?.entity || !v) return;
    const me = bot.entity.position.floored();
    const lights = bot.findBlocks({ matching: (b) => /torch|lantern|campfire/.test(b.name), maxDistance: 24, count: 30 });
    const seen = new Set<string>();
    const found: Array<{ room: NonNullable<ReturnType<typeof scanRoom>>; center: Vec3 }> = [];
    // the room we are in, plus rooms around each light (floor torch: its own cell; wall torch: next to it)
    const starts: Vec3[] = [me];
    for (const l of lights) {
      starts.push(l);
      for (const d of [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1), v3(0, -1, 0)]) starts.push(l.plus(d));
    }
    for (const st of starts) {
      // the floor level: go down to the first cell standing on something
      let f = st;
      for (let k = 0; k < 3 && f && !isSolid(bot.blockAt(f.offset(0, -1, 0))); k++) f = f.offset(0, -1, 0);
      const b = bot.blockAt(f);
      if (!b || b.boundingBox === 'block' || seen.has(`${f.x},${f.y},${f.z}`)) continue;
      const room = scanRoom(bot, f);
      if (!room) continue;
      for (const c of room.cells) seen.add(`${c.x},${c.y},${c.z}`);
      if (!shelterCheck(bot, room).ok) continue;
      const cx = Math.round((room.x0 + room.x1) / 2), cz = Math.round((room.z0 + room.z1) / 2);
      const center = room.cells.reduce((best, c) => (Math.hypot(c.x - cx, c.z - cz) < Math.hypot(best.x - cx, best.z - cz) ? c : best), room.cells[0]!);
      found.push({ room, center });
      if (!v.buildingAt(center)) {
        v.addBuilding({ x0: room.x0 - 1, z0: room.z0 - 1, x1: room.x1 + 1, z1: room.z1 + 1, y0: room.y, door: room.doors[0], owner: 'found' });
        this.log('info', `village: found a shelter (lit room) at ${fmtPos(center)}`);
        this.memory.discover('shelter (lit room)', center);
      }
    }
    // no home, or a "home" that is just a spot outdoors: move into a shelter
    const home = this.memory.place('home');
    const homeIsRoom = !!home && !!scanRoom(bot, v3(home.x, home.y, home.z)) || (!!home && !bot.blockAt(v3(home.x, home.y, home.z)));
    if (found.length && !homeIsRoom) {
      const mine = found.find((f) => f.room.cells.some((c) => c.equals(me))) ?? found.sort((a, b) => a.center.distanceTo(me) - b.center.distanceTo(me))[0]!;
      this.memory.setPlace('home', { ...mine.center, note: 'a shelter I found' });
      this.memory.learn(`My home is the shelter at ${fmtPos(mine.center)} (walls, roof, torch): beds go inside`);
      this.log('info', `moved into the shelter at ${fmtPos(mine.center)}`);
    }
  }

  /** Player's standing order; persisted in memory so a restart doesn't forget it. */
  private get order(): { from: string; text: string; until: number } | undefined {
    return this.memory.data.order;
  }
  private set order(o: { from: string; text: string; until: number } | undefined) {
    this.memory.setOrder(o);
  }
  private lastConclusionAt = 0;
  private lastSurfaceY: number | undefined;
  private lastSurfaceAt = 0;
  private noRise = 0;
  private lastHurtAt = 0;
  private readonly lastGift = new Map<string, number>();
  private currentReflex: Reflex | undefined;
  private reflexAbort: AbortController | undefined;
  private skippedInARow = 0;
  private pendingMentee: BotAgent | undefined;
  private lastLibraryWrite = 0;
  private lastAutoField = 0;
  private readonly lastMeeting = new Map<string, number>();
  private newsQueue: string[] = [];
  /** What this bot said lately (chatter filter). */
  private saidLog: Array<{ text: string; at: number }> = [];
  /** Questions we asked (kind -> time) and answers we gave (asker -> time). */
  private readonly askedAt = new Map<string, number>();
  private readonly answeredAt = new Map<string, number>();
  /** When the bot last joined (its first position is the world spawn until the server moves it). */
  private spawnedAt = 0;
  /** Steps of the last direct order still to run; when all succeeded the standing order is done. */
  private orderSteps: { left: number; failed: boolean } | undefined;
  /** Bumped by every direct order (a plan the model made meanwhile is dropped). */
  private orderSeq = 0;
  /** Recent failures per exact action (skill + args), for the "don't repeat it" guard. */
  private readonly failures = new Map<string, { n: number; at: number; why: string }>();
  /** Set while a skill that builds or repairs on purpose runs (it may dig at home). */
  private allowHomeDig = false;

  private readonly refusedDigs = new Map<string, number>();

  /** Why the bot must never dig here by accident (protected area, built block nearby, a home), or false. */
  private digForbidden(p: Vec3): string | false {
    if (this.deps.protectedAreas?.contains(p)) return 'protected area';
    if (this.manMade.touches(p)) return 'next to a built block';
    const homes = [this.memory.place('home'), ...(this.deps.homes?.all() ?? [])];
    const h = homes.find((h) => !!h && Math.abs(p.x - h.x) <= 4 && Math.abs(p.z - h.z) <= 4 && p.y >= h.y - 1 && p.y <= h.y + 4);
    return h ? `home at ${h.x},${h.y},${h.z}` : false;
  }
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
      this.spawnedAt = Date.now();
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
      // Hard safety net under everything: bot.dig refuses blocks of a home, a protected area or next to built
      // blocks unless a skill that builds/fixes on purpose allows it (ctx.allowHomeDig). A refused dig is logged
      // with where it came from.
      const dig = bot.dig.bind(bot);
      bot.dig = (async (block: Block, ...rest: unknown[]) => {
        // Plants (grass, ferns, flowers) are never part of a building: always fine to break.
        const plant = !!block && block.boundingBox === 'empty' && !MAN_MADE_RE.test(block.name) && !/wheat|carrots|potatoes|beetroots|_door|torch/.test(block.name);
        const once = plant || (!!block && ALLOWED_DIGS.delete(digKey(block.position)));
        const why = this.isApprentice()
          ? 'you are a newborn: wait until a teammate has taught you'
          : block && !this.allowHomeDig && !once ? this.digForbidden(block.position) : false;
        if (why) {
          const key = `${block.position.x},${block.position.y},${block.position.z}`;
          const n = (this.refusedDigs.get(key) ?? 0) + 1;
          this.refusedDigs.set(key, n);
          if (n === 1) {
            const from = (new Error().stack ?? '').split('\n').slice(2, 5).map((l) => l.trim().replace(/^at /, '').replace(/\(.*node_modules\//, '(')).join(' < ');
            const active = (bot.pathfinder as unknown as { movements: unknown }).movements;
            const planCheck = `${(moves as unknown as { exclusionBreak(b: unknown): number }).exclusionBreak(block)}${active === moves ? '' : ' (pathfinder is using OTHER movements!)'} canDig=${(active as { canDig?: boolean })?.canDig} excl=${(active as { exclusionAreasBreak?: unknown[] })?.exclusionAreasBreak?.length}`;
            this.log('warn', `refused to dig ${block.name} at ${fmtPos(block.position)} (${why}) during ${this.currentSkill ?? 'reflex'}; path check said ${planCheck}: ${from}`);
            this.jsonl.write('dig_refused', { block: block.name, pos: block.position, why, planCheck, skill: this.currentSkill, from });
          }
          // The pathfinder re-plans the same dig over and over: give up on this path after a few refusals.
          if (n >= 3 && bot.pathfinder.isMoving()) bot.pathfinder.stop();
          throw new Error(`refused to dig ${block.name}: ${why} (use the door)`);
        }
        return (dig as (...a: unknown[]) => Promise<void>)(block, ...rest);
      }) as Bot['dig'];
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
      // Swimming is slow and drowns hungry bots: walk around water when there is a way.
      (moves as unknown as { liquidCost: number }).liquidCost = 5; // not in the typings
      // Lava: no stepping on cells above lava, a heavy cost along lava edges.
      moves.exclusionAreasStep.push((block: { position: Vec3 }) => this.lava.stepCost(block.position));
      // Never dig next to water/lava or under sand/gravel. collectblock switches these OFF on every gather
      // (and it shares our Movements), so they are locked on.
      for (const k of ['dontCreateFlow', 'dontMineUnderFallingBlock']) {
        Object.defineProperty(moves, k, { get: () => true, set: () => undefined, configurable: false });
      }
      bot.pathfinder.setMovements(moves);
      // mineflayer-pvp and mineflayer-collectblock each make their OWN default Movements and switch the
      // pathfinder to them on every attack/gather: digging anywhere, scaffolding with dirt/cobblestone, no
      // doors, no home protection. Every later goto (even "go home") then used those until reset. Share ours.
      (bot as unknown as { pvp: { movements: unknown } }).pvp.movements = moves;
      (bot as unknown as { collectBlock: { movements: unknown } }).collectBlock.movements = moves;
      bot.pathfinder.thinkTimeout = 10_000; // default 5 s gave up too early in dense terrain
      (bot.pathfinder as unknown as { searchRadius: number }).searchRadius = 40; // impossible targets fail fast (not in the typings)
      this.manMade.refresh(bot);
      this.timers.push(setInterval(() => this.villageTick(), 15_000));
      this.timers.push(setInterval(() => this.socialTick(), 4_000));
      this.timers.push(setInterval(() => {
        if (this.bot?.entity) {
          this.manMade.refresh(this.bot);
          this.lava.refresh(this.bot);
        }
        this.refusedDigs.clear();
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
        this.answerQuestion(username, message, speakerPos);
        this.answerRequest(username, message, speakerPos);
        this.learnFromTalk(username, message);
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
        this.lastHurtAt = Date.now();
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

  /** Everything the bot knows in writing: books it carries, signs nearby, lessons, notes. */
  private knowledgeSources(): Array<{ from: string; text: string }> {
    const out: Array<{ from: string; text: string }> = [];
    const bot = this.bot;
    if (bot?.entity) {
      for (const i of bot.inventory.items().filter((x) => x.name === 'written_book')) {
        const c = readBookItem(i as unknown as Parameters<typeof readBookItem>[0]);
        if (c) out.push({ from: `your book "${c.title ?? 'untitled'}"`, text: c.pages.join(' ') });
      }
      for (const p of bot.findBlocks({ matching: (b) => b.name.endsWith('_sign'), maxDistance: 16, count: 6 })) {
        const t = ((bot.blockAt(p) as unknown as { getSignText?: () => string[] } | null)?.getSignText?.() ?? []).join(' ');
        if (t.trim()) out.push({ from: `the sign at ${p.x},${p.y},${p.z}`, text: t });
      }
    }
    for (const l of this.memory.data.lessons ?? []) out.push({ from: 'your lessons', text: l });
    for (const n of this.memory.data.notes) out.push({ from: 'your notes', text: n });
    return out;
  }

  /** The queued steps that come from a player's direct order (they survive re-planning). */
  private orderStepsOnly(): PlannedAction[] {
    return this.planQueue.filter((p) => p.thought.startsWith('order from'));
  }

  private wakePlanner(reason: string): void {
    // New information (chat, getting hurt): finish the current step, then re-plan with fresh state.
    if (this.planQueue.length) {
      this.planNote = `plan paused after: ${reason}; remaining steps were ${this.planQueue.map((p) => p.skill).join(', ')}`;
      this.planQueue = this.orderStepsOnly(); // a player's order keeps going; only the model's own plan pauses
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
      village: this.deps.village,
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
      if (b && this.memory.discover(what, b.position)) {
        this.jsonl.write('discovery', { what, pos: b.position });
        // Valuable ore is news for everyone (once per ~64-block area).
        if (/iron_ore|gold_ore|diamond_ore/.test(what)) {
          const p = b.position;
          this.news(`Found ${what.replace(/_/g, ' ')} at ${p.x} ${p.y} ${p.z}`, `find:${what}:${Math.round(p.x / 64)},${Math.round(p.z / 64)}`);
        }
      }
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

  /** Someone asked where something is and we know: answer (say if they are in earshot, else shout). */
  private answerQuestion(from: string, raw: string, speakerPos: { x: number; y: number; z: number } | undefined): void {
    if (from === this.name || !this.bot?.entity) return;
    const text = classifyChat(raw).text;
    const kinds = askedFor(text);
    if (!kinds.length || Date.now() - (this.answeredAt.get(from) ?? 0) < 60_000) return;
    const ans = answerFrom(kinds, this.memory.data, speakerPos);
    if (!ans) return;
    this.answeredAt.set(from, Date.now());
    const line = `${from}: ${ans}`;
    const near = speakerPos && this.bot.entity.position.distanceTo(this.bot.entity.position.clone().set(speakerPos.x, speakerPos.y, speakerPos.z)) <= this.deps.config.chatRange;
    if (near) this.speakLines([line]);
    else this.news(line);
    this.jsonl.write('answered', { to: from, question: text, answer: ans });
  }

  /** "Can you give me some food?" from someone in earshot: hand it over if we can spare it. */
  private answerRequest(from: string, raw: string, speakerPos: { x: number; y: number; z: number } | undefined): void {
    if (from === this.name || !this.bot?.entity || !speakerPos) return;
    const text = classifyChat(raw).text.toLowerCase();
    const m = /\b(give|bring|pass|toss|share|spare|need)\b.*\b(food|meat|beef|bread|pork|mutton|chicken|pickaxe|torch(?:es)?|planks|logs?|coal)\b/.exec(text);
    if (!m) return;
    if (!new RegExp(`\\b${this.name}\\b`, 'i').test(text) && !/\b(anyone|someone|me)\b/.test(text)) return;
    const d = this.bot.entity.position.distanceTo(this.bot.entity.position.clone().set(speakerPos.x, speakerPos.y, speakerPos.z));
    if (d > 32 || Date.now() - (this.lastGift.get(from) ?? 0) < 60_000) return;
    const want = m[2]!;
    const isFood = /food|meat|beef|bread|pork|mutton|chicken/.test(want);
    const have = isFood ? this.foodItemCount() : this.bot.inventory.items().filter((i) => i.name.includes(want.replace(/es$|s$/, ''))).reduce((n, i) => n + i.count, 0);
    const keep = isFood ? 2 : /pickaxe/.test(want) ? 1 : 0;
    if (have <= keep) return;
    const n = Math.max(1, Math.min(isFood ? 6 : 16, Math.floor((have - keep) / (isFood ? 1 : 2))));
    this.lastGift.set(from, Date.now());
    this.queueFirst({ skill: 'give', args: { player: from, item: isFood ? 'food' : want, count: n }, thought: `order from ${from}: they asked for ${want}` });
    this.speakLines([`${from}, coming with ${n} ${want}.`]);
  }

  /** "iron ore at 120 40 -5" said or shouted by someone: remember it as a find of that kind. */
  private learnFromTalk(from: string, raw: string): void {
    if (from === this.name) return;
    const text = classifyChat(raw).text;
    if (askedFor(text).length) return; // a question, not information
    const c = /(-?\d{1,6})[ ,]+(-?\d{1,4})[ ,]+(-?\d{1,6})/.exec(text);
    const kind = kindFromNews(text);
    if (!c || !kind) return;
    const pos = { x: Number(c[1]), y: Number(c[2]), z: Number(c[3]) };
    if (this.memory.discover(kind, pos)) this.jsonl.write('learned_place', { from, kind, pos });
  }

  /** After a failed search: ask everyone (shout) where to find it, at most once per 10 min per thing. */
  private askAround(skill: string, args: Record<string, unknown>, result: string): void {
    const m = /found no reachable (\S+)/.exec(result) ?? /^no (cow|sheep|pig|chicken)s? within/.exec(result);
    if (!m && !(skill === 'attack' && /none remembered/.test(result))) return;
    const what = String(m?.[1] ?? args.target ?? args.block ?? '').replace(/_/g, ' ');
    if (!what) return;
    // Only things you find in the world (animals, ores, trees, water...), not crafted items like torches.
    if (!askedFor(`where are ${what}?`).length) return;
    if (Date.now() - (this.askedAt.get(what) ?? 0) < 600_000) return;
    this.askedAt.set(what, Date.now());
    this.news(`Anyone know where ${what}${/s$/.test(what) ? '' : 's'} are?`);
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
    } else if (!/help|attack/i.test(text) && !askedFor(text).length) {
      const kind = kindFromNews(text);
      if (kind && c) this.memory.discover(kind, pos);
      else if (!kind) this.memory.discover(`spot shouted by ${from}: ${text.slice(0, 40)}`, pos);
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
      // A shortcut covers only part of "build a shelter AND put two beds inside": keep the whole message as a
      // standing order so the model does the rest after the shortcut ran.
      const more = /\b(and|then|also|with|plus)\b|,/i.test(msg) && msg.split(/\s+/).length > 4;
      this.order = cmd.steps[0]?.skill === 'wait' ? undefined : { from, text: msg.slice(0, 160), until: Date.now() + (more ? 15 * 60_000 : 90_000) };
      this.jsonl.write('order', { from, text: msg, steps: cmd.steps.map((s) => s.skill) });
      this.planQueue = cmd.steps.slice(1);
      this.forcedStep = cmd.steps[0];
      this.orderSeq++;
      this.orderSteps = { left: cmd.steps.length, failed: false };
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
    this.orderSeq++; // a plan the model is making right now did not see this message: drop it
    const known = relevantKnowledge(msg, this.knowledgeSources());
    this.planNote =
      `${from} sent you a PRIVATE message: "${msg.slice(0, 160)}". Answer THAT message directly in "say" (it is sent privately to ${from}); if it is an instruction, follow it; if it teaches you something, also write it in "learned"` +
      (known.length ? `. WHAT YOU ALREADY KNOW about this (answer FROM it, not from a guess): ${known.join(' | ')}` : '');
    if (known.length) this.jsonl.write('knowledge_hint', { question: msg, known });
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
  /** Newborn that may not break blocks yet. */
  isApprentice(): boolean {
    return (this.memory.data.apprenticeUntil ?? 0) > Date.now();
  }

  /** Called by the manager when this bot is born: wait for a teacher (or until the time runs out). */
  startApprenticeship(seconds: number): void {
    this.memory.data.apprenticeUntil = Date.now() + seconds * 1000;
    this.memory.save();
  }

  /** The teacher is done: free to work. */
  endApprenticeship(teacher: string): void {
    this.memory.data.apprenticeUntil = 0;
    this.memory.learn(`${teacher} is my mentor; ask them when unsure`);
    this.memory.save();
    this.lastPlanAt = 0;
  }

  /** Run this step next (before the current plan). */
  queueFirst(step: PlannedAction): void {
    if (this.forcedStep) this.planQueue.unshift(step);
    else this.forcedStep = step;
    this.lastPlanAt = 0;
  }

  /** Mentor a newborn: walk over (social tick), then teach. */
  mentor(student: BotAgent): void {
    this.pendingMentee = student;
    this.log('info', `going to welcome and teach ${student.name}`);
  }

  /**
   * Teach a newborn standing next to us: our 5 most valuable lessons, the village, utilities and the best
   * finds; said aloud (they hear it) and written into their memory. Then they may start working.
   */
  private teach(student: BotAgent): void {
    const m = this.memory;
    const sayLines: string[] = [];
    const v = m.place('village') ?? m.place('home');
    if (v) {
      student.memory.setPlace('village', { ...v, note: `${this.name} showed me` });
      sayLines.push(`Our village is at ${v.x} ${v.y} ${v.z}.`);
    }
    for (const k of ['crafting_table', 'chest', 'furnace', 'library']) {
      const p = m.place(k);
      if (!p) continue;
      student.memory.setPlace(k, p);
      sayLines.push(`${k.replace('_', ' ')} at ${p.x} ${p.y} ${p.z}.`);
    }
    const finds = whatToShare(m.data, student.memory.data, 6).filter((i) => i.kind === 'discovery');
    for (const f of finds) student.memory.discover(f.discovery!.what, f.discovery!);
    if (finds.length) sayLines.push(`I know: ${finds.map((f) => f.text).join('; ')}.`);
    for (const c of Object.values(m.data.storage ?? {})) student.memory.setChest(c, c.items, this.name);
    const lessons = topLessons(m.data.lessons ?? [], 5);
    for (const l of lessons) student.memory.learn(`From ${this.name}: ${l}`);
    lessons.forEach((l, i) => sayLines.push(`Lesson ${i + 1}: ${l}`));
    student.endApprenticeship(this.name);
    // ...and then reads what the tribe wrote down in the village library.
    if (this.deps.village?.data.library) student.queueFirst({ skill: 'library_read', args: {}, thought: 'order from my mentor: read the village library' });
    this.jsonl.write('mentor', { student: student.name, places: sayLines.length - lessons.length, lessons: lessons.length });
    this.log('info', `taught ${student.name}: ${lessons.length} lessons, ${finds.length} finds`);
    this.speakLines([`Welcome ${student.name}! Listen, this will keep you alive.`, ...sayLines]);
  }

  /** Says several lines one after another (spaced so the server does not kick for spam). */
  private speakLines(lines: string[]): void {
    const out = lines.flatMap((l) => l.match(/.{1,240}(\s|$)/g)?.map((x) => x.trim()) ?? [l]).slice(0, 10);
    out.forEach((l, i) => setTimeout(() => {
      if (this.bot?.entity) {
        this.bot.chat(l);
        this.saidLog.push({ text: l, at: Date.now() });
      }
    }, i * 1200));
    this.lastSpokeAt = Date.now();
  }

  /** Queue a news shout (one per key ever; sent when the shout cooldown allows). */
  news(text: string, key?: string): void {
    if (key) {
      const done = (this.memory.data.announced ??= []);
      if (done.includes(key)) return;
      done.push(key);
      if (done.length > 60) done.splice(0, done.length - 60);
      this.memory.save();
    }
    const max = this.deps.config.shout.maxWords;
    this.newsQueue.push(text.split(/\s+/).slice(0, max).join(' ')); // shouts are limited to maxWords
    if (this.newsQueue.length > 6) this.newsQueue.shift();
  }

  /** Every 4 s: walk to / teach a newborn, swap knowledge with bots in earshot, send queued news. */
  private socialTick(): void {
    const bot = this.bot;
    if (!this.running || !bot?.entity || this.isDead) return;
    const me = bot.entity.position;
    // mentoring
    const st = this.pendingMentee;
    if (st) {
      const sp = st.position();
      if (st.isDead || !sp) this.pendingMentee = undefined;
      else if (me.distanceTo(sp) <= 8) {
        this.pendingMentee = undefined;
        this.teach(st);
      } else if (!this.forcedStep && this.currentSkill !== 'goto' && !this.reflexBusy && !this.bunker) { // not out of the bunker at night
        this.forcedStep = { skill: 'goto', args: { x: Math.floor(sp.x), y: Math.floor(sp.y), z: Math.floor(sp.z) }, thought: `order from myself: welcome and teach newborn ${st.name}` };
        if (this.skillAbort && this.currentSkill) {
          this.interruptedBy = `going to teach ${st.name}`;
          this.skillAbort.abort();
        }
      }
    }
    // supplies: help a hungry / pickaxe-less teammate nearby (either side checks)
    for (const peer of this.deps.peers?.() ?? []) {
      const pp = peer.position();
      if (peer !== this && !peer.isDead && pp) this.shareSupplies(peer, me.distanceTo(pp));
    }
    // meetings: knowledge flows both ways between bots in earshot (initiated by one side of the pair)
    const range = this.deps.config.chatRange;
    for (const peer of this.deps.peers?.() ?? []) {
      if (peer === this || peer.isDead || peer.name < this.name || peer.isApprentice() || this.isApprentice()) continue;
      const pp = peer.position();
      if (!pp || me.distanceTo(pp) > range) continue;
      const key = peer.name;
      if (Date.now() - (this.lastMeeting.get(key) ?? 0) < 10 * 60_000) continue;
      const fromMe = this.shareInto(peer);
      const fromThem = peer.shareInto(this);
      // Only a real exchange counts as a meeting (an empty one used to block telling news for 10 min).
      if (fromMe + fromThem) {
        this.lastMeeting.set(key, Date.now());
        this.jsonl.write('meeting', { with: peer.name, told: fromMe, heard: fromThem });
      }
    }
    // news
    if (this.newsQueue.length && tryShout(bot, this.name, this.newsQueue[0]!, this.deps.config.shout)) {
      this.jsonl.write('news', { text: this.newsQueue.shift() });
      this.lastSpokeAt = Date.now();
    }
  }

  /** Tell `other` what we know and they don't (spoken aloud + stored in their memory). Returns items told. */
  shareInto(other: BotAgent): number {
    const items = whatToShare(this.memory.data, other.memory.data, 3, (a, b) => lessonSimilarity(a, b) >= 0.4);
    for (const it of items) {
      if (it.place) other.memory.setPlace(it.place.key, { ...it.place.p, note: `from ${this.name}` });
      if (it.discovery) other.memory.discover(it.discovery.what, it.discovery);
      if (it.lesson) other.memory.learn(`From ${this.name}: ${it.lesson}`);
    }
    if (items.length) this.speakLines([`${other.name}, ${items.map((i) => i.text).join('; ')}.`]);
    return items.length;
  }

  /** Edible items carried (not rotten flesh / spider eyes). */
  foodItemCount(): number {
    const bot = this.bot;
    if (!bot) return 0;
    return bot.inventory.items().filter((i) => bot.registry.foodsByName[i.name] && !/rotten|spider_eye|poisonous|pufferfish/.test(i.name)).reduce((n, i) => n + i.count, 0);
  }

  /** Hunger bar (0-20). */
  foodLevel(): number {
    return this.bot?.food ?? 20;
  }

  hasPickaxe(): boolean {
    return !!this.bot?.inventory.items().some((i) => /_pickaxe$/.test(i.name));
  }

  /**
   * Teammates help each other: a hungry bot with (almost) no food gets some of our spare food, a bot
   * without a pickaxe gets our spare one. We walk over and hand it over (give skill), at most every 3 min
   * per teammate.
   */
  private shareSupplies(peer: BotAgent, distance: number): void {
    const bot = this.bot;
    if (!bot || distance > 32 || this.forcedStep || this.isApprentice()) return;
    if (Date.now() - (this.lastGift.get(peer.name) ?? 0) < 180_000) return;
    const mine = this.foodItemCount();
    if (peer.foodItemCount() < 2 && peer.foodLevel() <= 14 && mine >= 4) {
      const n = Math.min(6, Math.floor(mine / 2));
      this.lastGift.set(peer.name, Date.now());
      this.queueFirst({ skill: 'give', args: { player: peer.name, item: 'food', count: n }, thought: `order from myself: ${peer.name} is hungry, share food` });
      this.speakLines([`${peer.name}, you look hungry - bringing you ${n} food.`]);
      return;
    }
    const picks = bot.inventory.items().filter((i) => /_pickaxe$/.test(i.name));
    if (!peer.hasPickaxe() && picks.length >= 2) {
      const worst = picks.sort((a, b) => TOOL_TIER.indexOf(a.name.split('_')[0]!) - TOOL_TIER.indexOf(b.name.split('_')[0]!))[0]!;
      this.lastGift.set(peer.name, Date.now());
      this.queueFirst({ skill: 'give', args: { player: peer.name, item: worst.name, count: 1 }, thought: `order from myself: give ${peer.name} my spare pickaxe` });
      this.speakLines([`${peer.name}, take my spare ${worst.name.replace('_', ' ')}.`]);
    }
  }

  /** A teammate just tossed us something: step to the dropped items near us (they land 2-3 blocks away). */
  async pickUpGift(): Promise<void> {
    const bot = this.bot;
    if (!bot?.entity || this.reflexBusy) return;
    await sleep(700); // let the items land
    const items = Object.values(bot.entities)
      .filter((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) <= 6)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    for (const it of items.slice(0, 3)) {
      if (!bot.entity || this.reflexBusy) return;
      await walkStraight(bot, it.position.floored(), 2500).catch(() => false);
    }
    bot.clearControlStates();
    this.jsonl.write('picked_up_gift', { items: items.length });
  }

  /** Does the water column above our head reach air (no block in the way) within 12 blocks? */
  private clearAbove(): boolean {
    const bot = this.bot!;
    const p = bot.entity.position.floored();
    for (let dy = 1; dy <= 12; dy++) {
      const b = bot.blockAt(p.offset(0, dy, 0));
      if (!b) return true;
      if (b.name === 'air' || b.name === 'cave_air') return true;
      if (b.boundingBox === 'block') return false;
    }
    return false;
  }

  /** Nearest air cell reachable through water/air (not through blocks), within `radius`; `sideways` skips our own column. */
  private nearestAir(radius: number, sideways = false): Vec3 | undefined {
    return this.pathToAir(radius, sideways)?.at(-1);
  }

  /** Route (cell by cell) through water to the nearest air cell, or undefined. */
  private pathToAir(radius: number, sideways = false): Vec3[] | undefined {
    const bot = this.bot!;
    const start = bot.entity.position.floored().offset(0, 1, 0);
    const key = (v: Vec3): string => `${v.x},${v.y},${v.z}`;
    const parent = new Map<string, Vec3 | null>([[key(start), null]]);
    const queue: Vec3[] = [start];
    const dirs = [v3(0, 1, 0), v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1), v3(0, -1, 0)];
    while (queue.length && parent.size < 3000) {
      const c = queue.shift()!;
      for (const d of dirs) {
        const n = c.plus(d);
        if (parent.has(key(n)) || n.distanceTo(start) > radius) continue;
        parent.set(key(n), c);
        const b = bot.blockAt(n);
        if (!b) continue;
        if ((b.name === 'air' || b.name === 'cave_air') && !(sideways && n.x === start.x && n.z === start.z)) {
          const path: Vec3[] = [n];
          let p = c;
          while (p && key(p) !== key(start)) {
            path.unshift(p);
            p = parent.get(key(p)) ?? (null as unknown as Vec3);
          }
          return path;
        }
        if (b.boundingBox !== 'block') queue.push(n); // water, kelp, seagrass...
      }
    }
    return undefined;
  }

  /** Current position (for other agents). */
  position(): Vec3 | undefined {
    return this.bot?.entity?.position;
  }

  /** Minecraft day number (for the births-per-day limit). */
  worldDay(): number | undefined {
    return this.bot?.time ? Math.floor(Number(this.bot.time.age) / 24000) : undefined;
  }

  /**
   * The oldest bot names a newborn with the model, from its memories (it may honour a dead friend with a
   * changed name). Never a name any bot ever had. Undefined if the model's answer is unusable.
   */
  async proposeName(dead: Array<{ name: string; cause?: string }>, used: ReadonlySet<string>): Promise<{ name: string; why: string } | undefined> {
    const prefix = this.deps.config.population.namePrefix;
    const { provider, tier } = this.deps.llm.forTier(this.tier);
    const lessons = (this.memory.data.lessons ?? []).filter((l) => /DEATH|mentor/.test(l)).slice(-5);
    const prompt =
      `You are ${this.name}, the oldest of your tribe. A newborn is about to join and you choose its name.\n` +
      `Bots who died: ${dead.slice(-8).map((d) => `${d.name.replace(prefix, '')} (${d.cause ?? 'unknown'})`).join(', ') || 'none'}.\n` +
      `Your memories: ${lessons.join(' | ') || 'none'}.\n` +
      `Pick ONE short first name (letters only, 3-10 letters). You may honour a fallen friend with a slightly changed name ` +
      `(e.g. Kira -> Kiro). It must not be any of: ${[...used].map((u) => u.replace(prefix, '')).slice(-40).join(', ')}.\n` +
      `Reply ONLY with JSON: {"name":"...","why":"<max 12 words>"}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await provider.complete({ system: 'You name newborns of a small tribe. Reply with JSON only.', messages: [{ role: 'user', content: prompt }], maxTokens: 60, temperature: 0.9, model: tier.model });
        const name = cleanBotName(res.text, prefix, used);
        if (name) return { name, why: /"why"\s*:\s*"([^"]{0,100})"/.exec(res.text)?.[1] ?? '' };
      } catch {
        /* fall through */
      }
    }
    return undefined;
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
    // (Fleeing/hunting/helping DO move: a bot fleeing into a wall corner stood there until a zombie killed it.)
    if (!bot.pathfinder.isMoving() || bot.isSleeping || this.currentReflex === 'fight' || bot.pvp.target || this.currentSkill === 'attack') {
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
      // Snagged on a corner (often when moving diagonally past a wall): jump first, then step sideways /
      // back, which frees the hitbox so the pathfinder can go on.
      const moves: Array<Array<'jump' | 'left' | 'right' | 'back'>> = [['jump'], ['left', 'jump'], ['right', 'jump'], ['back']];
      const m = moves[(this.stuckTries - 1) % moves.length]!;
      this.jsonl.write('stuck', { pos: { x: front.x, y: front.y, z: front.z }, action: m.join('+') });
      for (const c of m) bot.setControlState(c, true);
      await sleep(m.includes('back') ? 500 : 400);
      for (const c of m) bot.setControlState(c, false);
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
      // Out only when the sun is properly up (zombies live a while at dawn) and no monster is near the hole.
      bunkeredAtDay: !!this.bunker && bot.time.timeOfDay >= 1_000 && bot.time.timeOfDay < 12_000 && this.hostilesWithin(16).length === 0,
      preyKnown: this.nearestPrey() !== undefined || (this.memory.data.discoveries ?? []).some((d) => PREY_LABELS.has(d.what)),
      preyNear: this.nearestPrey(24) !== undefined,
      foodItems: this.foodItemCount(),
      helpCall:
        this.helpCall && Date.now() - this.helpCall.at < 90_000
          ? { distance: bot.entity.position.distanceTo(bot.entity.position.clone().set(this.helpCall.pos.x, this.helpCall.pos.y, this.helpCall.pos.z)) }
          : undefined,
      hasWeapon: bot.inventory.items().some((i) => /_sword$|_axe$/.test(i.name)),
      isNight: bot.time.timeOfDay >= 12_600 && bot.time.timeOfDay <= 23_000,
      isSleeping: bot.isSleeping,
      // Only a bed the sleep skill can use (within 32 blocks), and not while sleep waits out its cooldown:
      // a far-away remembered bed made "sleep" fail every minute and blocked the night shelter reflex,
      // so the bot stood still in the open all night.
      bedKnown:
        Date.now() - (this.reflexLastRun.get('sleep') ?? 0) >= REFLEX_COOLDOWN_MS.sleep! &&
        (['bed', 'spare_bed'] as const).some((k) => {
          const b = this.memory.place(k);
          return !!b && Math.hypot(b.x - bot.entity.position.x, b.z - bot.entity.position.z) <= 32;
        }),
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
    // Out of air: nothing else matters. A 40 s fight in water used to run to its end and the bot drowned
    // a second after it finally swam up. Cut the running reflex (and skill) so "surface" runs now.
    const b = this.bot;
    if (b?.entity && this.running && (b.entity as unknown as { isInWater?: boolean }).isInWater && b.oxygenLevel < 10 && this.currentReflex !== 'surface') {
      if (this.reflexBusy) {
        this.reflexAbort?.abort();
        try {
          b.pvp.forceStop();
        } catch {
          /* ignore */
        }
        b.pathfinder.stop();
      }
    }
    if (!this.running || this.reflexBusy || !this.bot?.entity) return;
    // In our sealed night hole nothing can reach us: ignore monsters around unless we are actually being hurt
    // (a bot climbed out to fight a zombie it could not even reach, and died).
    const inHole = !!this.bunker && this.bot.entity.position.distanceTo(this.bunker.offset(0.5, 0, 0.5)) <= 1.5;
    const hostile = inHole && Date.now() - this.lastHurtAt > 3_000 ? undefined : this.nearestHostile();
    const choice = chooseReflex(this.reflexState(hostile));
    if (!choice) return;
    const cd = REFLEX_COOLDOWN_MS[choice];
    if (cd && Date.now() - (this.reflexLastRun.get(choice) ?? 0) < cd) return;
    // Don't fight what the current skill is already fighting.
    if (choice === 'fight' && this.currentSkill === 'attack') return;
    if (choice === 'sleep' && this.currentSkill === 'sleep') return;
    this.reflexLastRun.set(choice, Date.now());
    this.reflexBusy = true;
    this.currentReflex = choice;
    if (this.skillAbort && this.currentSkill) {
      this.interruptedBy = choice;
      this.skillAbort.abort();
    }
    const ac = new AbortController();
    this.reflexAbort = ac;
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
      this.currentReflex = undefined;
    }
    this.log('debug', `reflex ${choice}: ${result}`);
    this.jsonl.write('reflex', { reflex: choice, result, ms: Date.now() - started });
    // Tell the model what the reflex did and where that left the bot (it only knew "interrupted (warm_home)"
    // and then e.g. planned another shelter next to the finished one).
    const bot = this.bot;
    if (bot?.entity && result && result !== 'aborted') {
      const here = bot.entity.position.floored();
      const room = scanRoom(bot, here);
      const home = this.memory.place('home');
      const atHome = !!home && !!room && room.cells.some((c) => Math.abs(c.x - home.x) <= 1 && Math.abs(c.z - home.z) <= 1);
      const where = atHome ? 'inside your home' : room ? 'inside a room' : 'outdoors';
      const line = `[reflex] ${choice}: ${result.slice(0, 140)} - now at ${fmtPos(here)}, ${where}`;
      const last = this.recentResults[this.recentResults.length - 1];
      if (!last?.startsWith(`[reflex] ${choice}:`)) this.recentResults.push(line);
      else this.recentResults[this.recentResults.length - 1] = line; // repeated reflex: keep only the latest
      while (this.recentResults.length > 6) this.recentResults.shift();
    }
  }

  private async runReflex(r: Reflex, hostile: Entity | undefined, signal: AbortSignal): Promise<string> {
    const bot = this.bot!;
    const ctx = this.makeCtx(signal);
    switch (r) {
      case 'escape_lava':
      case 'extinguish':
      case 'surface': {
        bot.pathfinder.stop();
        // Straight up only works if the water above opens to air; under a ledge/ceiling the bot used to
        // "swim up" into the block for 18 s and drown. Then swim to the nearest air instead, or dig up.
        // Not rising although the way up looks open (falling water pushes you down): get out sideways.
        const yNow = bot.entity.position.y;
        if (r === 'surface' && this.lastSurfaceY !== undefined && yNow <= this.lastSurfaceY + 0.3 && Date.now() - this.lastSurfaceAt < 8_000) this.noRise++;
        else this.noRise = 0;
        this.lastSurfaceY = yNow;
        this.lastSurfaceAt = Date.now();
        if (r === 'surface' && (!this.clearAbove() || this.noRise >= 2)) {
          const route = this.pathToAir(12, this.noRise >= 2);
          const air = route?.at(-1);
          if (route && air) {
            // The pathfinder cannot plan underwater: swim the route cell by cell (head cells of the path).
            const end = Date.now() + 8_000;
            try {
              for (const cell of route) {
                while (Date.now() < end && !signal.aborted) {
                  const head = bot.entity.position.offset(0, 1.6, 0);
                  if (head.distanceTo(cell.offset(0.5, 0.5, 0.5)) < 0.7) break;
                  await bot.lookAt(cell.offset(0.5, 0.5, 0.5), true);
                  const up = cell.y + 0.5 > head.y + 0.2;
                  bot.setControlState('forward', Math.hypot(cell.x + 0.5 - head.x, cell.z + 0.5 - head.z) > 0.3);
                  bot.setControlState('jump', up);
                  bot.setControlState('sneak', cell.y + 0.5 < head.y - 0.6); // swim down
                  bot.setControlState('sprint', true);
                  await sleep(100);
                }
              }
            } finally {
              bot.clearControlStates();
            }
            if ((bot.blockAt(bot.entity.position.offset(0, 1.6, 0).floored())?.name ?? '') === 'water') return `swimming towards air at ${fmtPos(air)}`;
            return `swam out to air at ${fmtPos(air)}`;
          }
          const above = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0));
          if (above && above.boundingBox === 'block' && bot.canDigBlock(above) && above.digTime(null, false, true, false, [], []) < 1500) {
            ALLOWED_DIGS.add(digKey(above.position));
            await bot.dig(above, true).catch(() => undefined);
          }
        }
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
          while (target && Date.now() < end && !signal.aborted) {
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
          const atHome = bot.entity.position.distanceTo(bot.entity.position.clone().set(home.x, home.y, home.z)) <= 3;
          const close = this.hostilesWithin(3)[0];
          if (!atHome && close) return `cornered on the way home: ${await this.runReflex('fight', close, signal)}`;
          return atHome ? 'fled home' : 'could not get home';
        }
        if (!hostile) return 'nothing to flee';
        const r = await this.runAway(ctx, signal, 15_000);
        const close = this.hostilesWithin(3)[0];
        // Stuck with the monster on us: fighting back beats running into a wall until dead.
        if (r === 'still chased' && close) return `cornered: ${await this.runReflex('fight', close, signal)}`;
        return r;
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
        if (!r.feet) {
          // No hole possible here (water next to it, built ground...): wall ourselves in instead.
          const hut = await emergencyHut(ctx);
          if (hut.feet) {
            r = hut;
            this.memory.setPlace('bunker', { ...hut.feet, note: 'hut' });
          } else {
            r = { why: `${r.why}; ${hut.why}` };
          }
        }
        if (r.feet) {
          this.bunker = r.feet;
          this.planQueue = []; // the rest of a daytime plan would walk straight back out
          if (this.memory.place('bunker')?.note !== 'hut') this.memory.setPlace('bunker', r.feet); // survives restarts (planner stays put until morning)
          this.memory.learn('At night in the open, dig 3 down and seal the top: zombies cannot reach you');
          this.jsonl.write('bunker', { pos: r.feet, result: r.why });
        }
        return `night: ${r.why}`;
      }
      case 'leave_bunker': {
        const b = this.memory.place('bunker');
        const r = b?.note === 'hut' && this.bunker ? await leaveHut(ctx, this.bunker) : await goSurface(ctx);
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
      // Flagged as bunkered but not actually in the hole (fell out, dug beside itself, was moved): forget the
      // bunker so the night reflex can act again (it stood outside all night "bunkered" with 1 health).
      if (this.bunker && this.bot?.entity && Date.now() - this.spawnedAt > 10_000 && this.bot.entity.position.distanceTo(this.bunker.offset(0.5, 0, 0.5)) > 2.5) {
        this.log('info', `not in my bunker at ${fmtPos(this.bunker)} any more (at ${fmtPos(this.bot.entity.position)}): forgetting it`);
        this.bunker = undefined;
        delete this.memory.data.places.bunker;
      }
      const inBunkerAtNight = !!this.bunker && (this.bot?.time.timeOfDay ?? 0) >= 12_000;
      // In the bunker at night the bot only thinks when spoken to (answer, read, write - nothing that leaves).
      // A newborn waits for its teacher (it only answers when spoken to).
      const waitingForTeacher = this.isApprentice() && !this.forcedStep && !this.replyTo;
      if (this.reflexBusy || Date.now() - this.lastPlanAt < minInterval || !this.bot?.entity || waitingForTeacher || (inBunkerAtNight && !this.forcedStep && !this.replyTo)) {
        await sleep(250);
        continue;
      }
      let action: PlannedAction;
      // Dug in for the night: steps from orders/teaching that would walk out wait until morning.
      if (inBunkerAtNight && this.forcedStep && !BUNKER_SAFE_SKILLS.has(this.forcedStep.skill)) {
        await sleep(1000);
        continue;
      }
      if (inBunkerAtNight && !this.forcedStep && this.planQueue.length && !BUNKER_SAFE_SKILLS.has(this.planQueue[0]!.skill)) {
        await sleep(1000);
        continue;
      }
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
          const seq = this.orderSeq;
          const steps = await this.plan();
          if (this.isDead || !this.running) break; // died while the model was thinking
          // A player's order arrived while the model was thinking: its steps win, drop this plan.
          if (this.orderSeq !== seq) continue;
          // Dug in for the night: only steps that don't leave the hole (talking, reading, writing).
          if (this.bunker && (this.bot?.time.timeOfDay ?? 0) >= 12_000) {
            const safe = steps.filter((x) => BUNKER_SAFE_SKILLS.has(x.skill));
            this.planQueue = safe.slice(1);
            if (!safe[0]) continue;
            steps.splice(0, steps.length, ...safe);
          }
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
        this.planQueue = this.orderStepsOnly();
      }
    }
  }

  private async plan(): Promise<PlannedAction[]> {
    const bot = this.bot!;
    const replyFor = this.replyTo; // the private message this plan can see (and so may answer)
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
      village: this.deps.village,
      queued: this.forcedStep ? [this.forcedStep, ...this.planQueue] : this.planQueue,
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
        this.memory.addThought(this.lastThought, parsed.steps.map((x) => x.skill).join(' -> '));
        // Only a plan made AFTER the message arrived answers it (an older plan's "Heading to gather logs"
        // was whispered back as the answer to "on what level are diamonds?").
        const answeringTo = replyFor && this.replyTo === replyFor ? replyFor : undefined;
        if (answeringTo) this.replyTo = undefined;
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
        // Narration ("Heading to gather 8 logs") and repeats drown real information: only answers and new,
        // useful things are said aloud.
        if (this.isDead) return [];
        const chatter = !answeringTo && !!parsed.say && (isChatter(parsed.say) || saidRecently(parsed.say, this.saidLog));
        if (parsed.say && this.bot && chatter) {
          this.jsonl.write('said_skipped', { text: parsed.say });
        } else if (parsed.say && this.bot) {
          if (answeringTo) this.bot.whisper(answeringTo, parsed.say);
          else this.bot.chat(parsed.say);
          this.saidLog.push({ text: parsed.say, at: Date.now() });
          this.saidLog = this.saidLog.filter((x) => Date.now() - x.at < 600_000);
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
    // The same action failed twice in the last 5 minutes: don't burn another minute on it (the model kept
    // asking for "gather log" on a treeless plain 10+ times). Player orders always run.
    const fkey = `${action.skill} ${JSON.stringify(action.args)}`;
    const prev = this.failures.get(fkey);
    if (prev && prev.n >= 2 && Date.now() - prev.at < 300_000 && !action.thought.startsWith('order from')) {
      const result = `SKIPPED: ${fkey} already failed ${prev.n} times in the last minutes (${prev.why.slice(0, 120)}). Do something different.`;
      this.log('info', result);
      // The model keeps choosing skipped actions: after 4 in a row run the safe fallback (wood / explore)
      // so the bot does not stand still (it once "planned" the same skipped plan for minutes).
      if (++this.skippedInARow >= 4) {
        this.skippedInARow = 0;
        this.planQueue = [];
        if (this.bot) {
          const fb = fallbackAction(countItem(this.bot, /_log$/));
          // if the fallback itself keeps failing (no trees here), go somewhere else instead
          const fbFailed = (this.failures.get(`${fb.skill} ${JSON.stringify(fb.args)}`)?.n ?? 0) >= 2;
          this.forcedStep = fbFailed ? { thought: 'order from fallback: explore elsewhere', skill: 'explore', args: { distance: 64 } } : { ...fb, thought: `order from fallback: ${fb.thought}` };
        }
      }
      return { result, interrupted: false };
    }
    this.skippedInARow = 0;
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
      this.allowHomeDig = HOME_BUILD_SKILLS.has(action.skill);
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
      this.allowHomeDig = false;
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
    // Chopped trees: plant the saplings we picked up, so the woods around the village grow back
    // (generations of bots cut it bare and newborns found no wood at all).
    if (action.skill === 'gather' && /log|wood|tree/.test(String(action.args.block ?? '')) && /^gathered/.test(result) && this.bot) {
      const saplings = this.bot.inventory.items().filter((i) => i.name.endsWith('_sapling')).reduce((n, i) => n + i.count, 0);
      if (saplings > 0 && !this.forcedStep) this.forcedStep = { skill: 'plant_sapling', args: { count: Math.min(4, saplings) }, thought: 'order from myself: replant the trees I cut' };
    }
    // We handed something to a teammate: they step over and pick it up.
    if (action.skill === 'give' && /^gave /.test(result)) {
      const to = String(action.args.player ?? '');
      void this.deps.peers?.().find((p) => p.name === to && !p.isDead)?.pickUpGift();
    }
    // Tell the model what really changed (a gather that "timed out" may still have collected a lot).
    const delta = this.inventoryDelta(invBefore);
    if (delta && !result.includes(delta)) result = `${result}; inventory ${delta}`;
    const line = `${action.skill}(${JSON.stringify(action.args)}) -> ${result}`;
    // A direct order whose steps all succeeded is finished: clear it, or the model keeps redoing it
    // ("build a shelter ..." stayed on screen and the bot built shelter after shelter).
    if (this.orderSteps && action.thought.startsWith('order from') && !/will resume the order/.test(result)) {
      this.orderSteps.left--;
      if (looksFailed(result)) this.orderSteps.failed = true;
      if (this.orderSteps.left <= 0) {
        if (!this.orderSteps.failed) this.order = undefined;
        this.orderSteps = undefined;
      }
    }
    if (looksFailed(result) && !/^interrupted/.test(result)) {
      this.askAround(action.skill, action.args, result);
      const f = this.failures.get(fkey);
      this.failures.set(fkey, { n: f && Date.now() - f.at < 300_000 ? f.n + 1 : 1, at: Date.now(), why: result });
    } else if (!looksFailed(result)) {
      this.failures.delete(fkey);
    }
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
