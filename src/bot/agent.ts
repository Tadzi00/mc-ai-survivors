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
import { countItem, gotoNear, gotoXZ, HOSTILE_MOBS } from '../skills/helpers.js';
import { runSkill } from '../skills/index.js';
import { eatSkill, sleepSkill } from '../skills/impl/survival.js';
import { placeTorchSkill } from '../skills/impl/building.js';
import { JsonlLog, log, shortHash } from '../util/log.js';
import { AbortError, sleep, TimeoutError } from '../util/time.js';
import { fallbackAction, parseAction, type PlannedAction } from './action.js';
import { ChatLog } from './chat.js';
import { Memory } from './memory.js';
import { buildObservation } from './observation.js';
import { retryPrompt, systemPrompt } from './prompts.js';
import { chooseReflex, type Reflex, type ReflexState } from './reflexChoice.js';

const { pathfinder, Movements } = pathfinderPkg;

export interface AgentDeps {
  config: Config;
  llm: LLMRegistry;
  seasons: SeasonsApi;
}

export interface AgentEvents {
  onSpawn(agent: BotAgent): void;
  onDeath(agent: BotAgent, cause: string): void;
  onDisconnect(agent: BotAgent, reason: string): void;
}

/** Entity metadata index 0 is a bit field; bit 0x01 = on fire. */
const isOnFire = (flags: unknown): boolean => typeof flags === 'number' && (flags & 0x01) === 1;

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
      bot.pathfinder.setMovements(moves);
      this.running = true;
      this.lastHealth = bot.health;
      this.log('info', `spawned at ${bot.entity.position.floored().toString()}`);
      this.jsonl.write('spawn', { tier: this.tier, pos: bot.entity.position });
      this.events.onSpawn(this);
      this.timers.push(setInterval(() => void this.reflexTick(), this.deps.config.bot.reflexIntervalMs));
      this.timers.push(setInterval(() => void this.temperatureTick(), this.deps.config.bot.temperatureCheckSeconds * 1000));
      void this.temperatureTick();
      void this.plannerLoop();
    });

    bot.on('chat', (username, message) => {
      const speaker = bot.players[username]?.entity;
      if (this.chat.offer(this.name, username, message, bot.entity?.position, speaker?.position, this.deps.config.chatRange)) {
        this.jsonl.write('heard', { from: username, text: message });
        this.wakePlanner('chat');
      }
    });
    bot.on('messagestr', (msg, position) => {
      if (position === 'system' || position === 'game_info') {
        this.recentSystemMsgs.push({ at: Date.now(), text: msg });
        this.recentSystemMsgs = this.recentSystemMsgs.filter((m) => Date.now() - m.at < 10_000);
      }
    });
    bot.on('health', () => {
      if (bot.health < this.lastHealth - 0.5) this.wakePlanner('hurt');
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
    const timer = setTimeout(() => ac.abort(), 20_000);
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
        void bot.pvp.attack(hostile);
        const end = Date.now() + 12_000;
        try {
          while (Date.now() < end && hostile.isValid && bot.entities[hostile.id]) {
            if (bot.health < 8) return 'disengaged (low health)';
            await sleep(400, signal);
          }
        } finally {
          await bot.pvp.stop().catch(() => bot.pvp.forceStop());
        }
        return hostile.isValid ? 'fought' : 'killed';
      }
      case 'flee': {
        const home = this.memory.place('home');
        if (home && home.x !== undefined) {
          await gotoNear(ctx, home.x, home.y, home.z, 1, 15_000).catch(() => undefined);
          return 'fled home';
        }
        if (!hostile) return 'nothing to flee';
        const me = bot.entity.position;
        const away = me.minus(hostile.position);
        const len = Math.max(0.1, Math.hypot(away.x, away.z));
        await gotoXZ(ctx, me.x + (away.x / len) * 16, me.z + (away.z / len) * 16, 8_000).catch(() => undefined);
        return 'fled';
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
      this.lastPlanAt = Date.now();
      let action: PlannedAction;
      try {
        action = await this.plan();
      } catch (e) {
        this.log('warn', `planner error: ${(e as Error).message}`);
        this.jsonl.write('planner_error', { error: (e as Error).message });
        action = fallbackAction(countItem(this.bot, /_log$/));
        await sleep(5000);
      }
      if (!this.running) break;
      await this.execute(action);
    }
  }

  private async plan(): Promise<PlannedAction> {
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
    });
    this.interruptedBy = undefined;
    this.chat.takeUnread();
    const system = systemPrompt(this.tier, this.name, this.deps.config.chatRange);
    const messages: ChatMessage[] = [{ role: 'user', content: `${obs}\n\nChoose your next action.` }];
    const started = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await provider.complete({ system, messages, maxTokens: tier.maxTokens, temperature: tier.temperature, model: tier.model });
      const parsed = parseAction(res.text, this.tier);
      this.jsonl.write('decision', {
        obsHash: shortHash(obs),
        attempt,
        ms: Date.now() - started,
        raw: res.text.slice(0, 600),
        ok: parsed.ok,
        error: parsed.ok ? undefined : parsed.error,
      });
      if (parsed.ok) return parsed.action;
      messages.push({ role: 'assistant', content: res.text.slice(0, 1000) }, { role: 'user', content: retryPrompt(parsed.error) });
    }
    return fallbackAction(countItem(bot, /_log$/));
  }

  private async execute(action: PlannedAction): Promise<void> {
    const ac = new AbortController();
    this.skillAbort = ac;
    this.currentSkill = action.skill;
    const timeoutMs = this.deps.config.bot.skillTimeoutSeconds * 1000;
    const timer = setTimeout(() => ac.abort(new TimeoutError()), timeoutMs);
    const started = Date.now();
    let result: string;
    this.log('info', `${action.skill} ${JSON.stringify(action.args)} — ${action.thought}`);
    try {
      result = await runSkill(this.makeCtx(ac.signal), action.skill, action.args);
    } catch (e) {
      if (ac.signal.aborted) {
        result = ac.signal.reason instanceof TimeoutError ? `timed out after ${timeoutMs / 1000}s` : `interrupted (${this.interruptedBy ?? 'event'})`;
      } else {
        result = `failed: ${(e as Error).message}`;
      }
      try {
        this.bot?.pathfinder.stop();
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
  }
}
