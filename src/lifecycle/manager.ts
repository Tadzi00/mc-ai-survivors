import path from 'node:path';
import { writeJsonFile } from '../util/fsjson.js';
import type { Config } from '../config.js';
import type { BedPos } from '../contracts.js';
import { BotAgent, type AgentDeps } from '../bot/agent.js';
import type { BridgeApi } from '../rcon/server.js';
import { JsonlLog, log } from '../util/log.js';
import { assignTier, assignTiers, decideSpawn, nextBotName, type Tier } from './policy.js';
import type { OrchestratorState } from './state.js';

/**
 * Population lifecycle: seeds the first bots, polls the bridge plugin's spawn rule, spawns newborns
 * into free beds, and handles PERMANENT death (never respawn, never reuse a name).
 */
const JOIN_SPACING_MS = 5_000;

export class LifecycleManager {
  private readonly agents = new Map<string, BotAgent>();
  private readonly newborns = new Map<string, BedPos>();
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private ticking = false;
  private readonly jsonl: JsonlLog;

  constructor(
    private readonly config: Config,
    private readonly state: OrchestratorState,
    private readonly bridge: BridgeApi,
    private readonly deps: AgentDeps,
  ) {
    this.jsonl = new JsonlLog(config.paths.logs, 'orchestrator');
    deps.peers = () => [...this.agents.values()];
  }

  /** Current Minecraft day as seen by any living bot. */
  private worldDay(): number | undefined {
    for (const a of this.agents.values()) {
      const d = a.worldDay();
      if (d !== undefined && !a.isDead) return d;
    }
    return undefined;
  }

  /** Is a living, settled (not newborn) bot within `birthNeedsBotWithin` blocks of the bed? */
  private botNear(bed: BedPos): boolean {
    const r = this.config.population.birthNeedsBotWithin;
    if (!r) return true;
    for (const a of this.agents.values()) {
      if (a.isDead || a.isApprentice()) continue;
      const p = a.position();
      if (p && Math.hypot(p.x - bed.x, p.y - bed.y, p.z - bed.z) <= r) return true;
    }
    return false;
  }

  start(): void {
    const alive = this.state.alive();
    for (const rec of alive) {
      log('info', 'life', `resuming ${rec.name} (${rec.tier})`);
      this.launch(rec.name, rec.tier, rec.bed ?? null);
    }
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.population.spawnPollSeconds * 1000);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const a of this.agents.values()) a.stop();
    this.agents.clear();
  }

  /** state/status.json: one line per living bot, refreshed every poll. Handy to see what everyone does. */
  private writeStatus(): void {
    try {
      writeJsonFile(path.join(this.config.paths.state, 'status.json'), {
        at: new Date().toISOString(),
        bots: [...this.agents.values()].filter((a) => !a.isDead).map((a) => a.status()),
        dead: this.state.bots.filter((r) => r.status !== 'alive').slice(-10).map((r) => ({ name: r.name, cause: r.deathCause ?? null })),
      });
    } catch {
      /* best effort */
    }
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    this.writeStatus();
    try {
      const p = this.config.population;
      const alive = this.state.alive();
      let canSpawn;
      if (alive.length > 0 && alive.length < p.maxBots) {
        canSpawn = await this.bridge.canSpawn(alive.map((b) => b.name)).catch((e: unknown) => {
          log('warn', 'life', `bridge query failed: ${String(e)}`);
          return undefined;
        });
      }
      const day = this.worldDay();
      const decision = decideSpawn({
        aliveCount: alive.length,
        maxBots: p.maxBots,
        initialBots: p.initialBots,
        reseedWhenExtinct: p.reseedWhenExtinct,
        everSpawned: this.state.bots.length > 0,
        canSpawn,
        birthsToday: day === undefined ? 0 : this.state.bots.filter((b) => b.bornDay === day && b.namedBy !== 'seed').length,
        maxBirthsPerDay: p.maxBirthsPerDay,
        botNearBed: (bed) => this.botNear(bed),
      });
      if (decision.action === 'none') {
        log('debug', 'life', `no spawn: ${decision.reason}${canSpawn?.missing.length ? ` (missing beds: ${canSpawn.missing.join(',')})` : ''}`);
        return;
      }
      if (decision.action === 'seed') {
        const tiers = assignTiers([], p.smartSlots, decision.count);
        log('info', 'life', `${decision.reason}: spawning ${decision.count} bots`);
        this.jsonl.write('seed', { reason: decision.reason, count: decision.count });
        if (p.graceOnSeed) {
          await this.bridge.graceStart().catch((e: unknown) => log('warn', 'life', `grace start failed: ${String(e)}`));
        }
        for (const tier of tiers) this.birth(tier, null);
        return;
      }
      const tier = assignTier(alive.map((b) => b.tier), p.smartSlots);
      const named = await this.nameByElder();
      const name = named?.name ?? this.peekName();
      const ok = await this.bridge.assign(name, decision.bed);
      if (!ok) {
        log('warn', 'life', `could not assign bed ${JSON.stringify(decision.bed)} to ${name}`);
        return;
      }
      log('info', 'life', `shelter rule met -> newborn ${name} (${tier}) at bed ${decision.bed.x},${decision.bed.y},${decision.bed.z}${named ? ` - named by ${named.by}: ${named.why}` : ''}`);
      this.birth(tier, decision.bed, name, named?.by);
      if (named) this.agents.get(named.by)?.news(`Welcome ${name}! ${named.why}`.slice(0, 90));
    } finally {
      this.ticking = false;
    }
  }

  /** The oldest living bot picks the newborn's name (model + memories); undefined -> numbered name. */
  private async nameByElder(): Promise<{ name: string; why: string; by: string } | undefined> {
    if (!this.config.population.namedByElder) return undefined;
    const elder = this.state
      .alive()
      .sort((a, b) => a.bornAt.localeCompare(b.bornAt))
      .map((r) => this.agents.get(r.name))
      .find((a) => a && !a.isDead);
    if (!elder) return undefined;
    const dead = this.state.bots.filter((b) => b.status === 'dead').map((b) => ({ name: b.name, cause: b.deathCause }));
    const r = await Promise.race([
      elder.proposeName(dead, this.state.usedNames()),
      new Promise<undefined>((res) => setTimeout(() => res(undefined), 60_000)),
    ]).catch(() => undefined);
    return r ? { ...r, by: elder.name } : undefined;
  }

  private peekName(): string {
    return nextBotName(this.config.population.namePrefix, this.state.nameCounter, this.state.usedNames()).name;
  }

  private birth(tier: Tier, bed: BedPos | null, presetName?: string, namedBy?: string): void {
    const n = nextBotName(this.config.population.namePrefix, this.state.nameCounter, this.state.usedNames());
    const name = presetName ?? n.name;
    if (!presetName) this.state.nameCounter = n.counter;
    this.state.add({ name, tier, status: 'alive', bornAt: new Date().toISOString(), bed, bornDay: this.worldDay(), namedBy: bed ? namedBy : 'seed' });
    this.jsonl.write('birth', { name, tier, bed });
    this.fresh.add(name);
    if (bed && this.config.population.spawnAtBed) this.newborns.set(name, bed);
    this.launch(name, tier, bed);
  }

  private nextJoinAt = 0;

  private launch(name: string, tier: Tier, bed: BedPos | null): void {
    const agent = new BotAgent(name, tier, this.deps, {
      onSpawn: (a) => void this.onSpawn(a),
      onDeath: (a, cause) => void this.onDeath(a, cause),
      onDisconnect: (a, reason) => this.onDisconnect(a, reason),
    }, bed);
    this.agents.set(name, agent);
    const ready = this.config.population.autoWhitelist
      ? this.bridge.whitelistAdd(name).catch((e: unknown) => log('warn', 'life', `whitelist add ${name} failed: ${String(e)}`))
      : Promise.resolve();
    // Paper rejects joins from one IP closer than connection-throttle (4s), so stagger them.
    const now = Date.now();
    const joinAt = Math.max(now, this.nextJoinAt);
    this.nextJoinAt = joinAt + JOIN_SPACING_MS;
    void ready
      .then(() => new Promise((r) => setTimeout(r, joinAt - now)))
      .then(() => {
        if (!this.stopping && this.agents.get(name) === agent) agent.start();
      });
  }

  /** Bots born this run (not resumed): they get a mentor on first spawn. */
  private readonly fresh = new Set<string>();

  /** The nearest other living bot teaches the newborn what it knows (see BotAgent.mentor). */
  private assignMentor(student: BotAgent): void {
    const me = this.deps.roster.get(student.name, 60_000);
    let best: BotAgent | undefined;
    let bestD = Infinity;
    for (const a of this.agents.values()) {
      if (a === student || a.isDead) continue;
      const p = this.deps.roster.get(a.name, 60_000);
      const d = me && p ? Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z) : 1e9;
      if (d < bestD) {
        best = a;
        bestD = d;
      }
    }
    if (best) best.mentor(student);
  }

  private async onSpawn(agent: BotAgent): Promise<void> {
    const bed = this.newborns.get(agent.name);
    if (this.fresh.delete(agent.name)) {
      if (bed) {
        // Born in a bed: that is home, and it waits for a teammate to teach it before it may break blocks.
        agent.memory.setPlace('home', { x: bed.x, y: bed.y, z: bed.z, note: 'where I was born' });
        agent.memory.setPlace('bed', { x: bed.x, y: bed.y, z: bed.z });
        agent.startApprenticeship(this.config.population.apprenticeSeconds);
        setTimeout(() => this.assignMentor(agent), 4_000); // only newborns get a teacher, not the first bots
      }
    }
    if (!bed) return;
    this.newborns.delete(agent.name);
    await this.bridge.placeAtBed(agent.name, bed).catch((e: unknown) => log('warn', 'life', `placeAtBed failed: ${String(e)}`));
  }

  private async onDeath(agent: BotAgent, cause: string): Promise<void> {
    this.agents.delete(agent.name);
    const rec = this.state.markDead(agent.name, cause);
    this.jsonl.write('death', { name: agent.name, tier: agent.tier, cause });
    if (rec?.tier === 'smart') log('info', 'life', `smart slot freed by ${agent.name}; next newborn will be smart`);
    await this.bridge.unassign(agent.name).catch(() => undefined);
    const alive = this.state.alive().length;
    log('warn', 'life', `${agent.name} is gone forever (${cause}). ${alive} alive.`);
    // The nearest living bot spreads the news (where, and what killed them).
    const where = agent.position() ?? this.deps.roster.get(agent.name, 120_000);
    let teller: BotAgent | undefined;
    let best = Infinity;
    for (const a of this.agents.values()) {
      const p = a.position();
      if (a.isDead || !p || !where) continue;
      const d = Math.hypot(p.x - where.x, p.z - where.z);
      if (d < best) {
        best = d;
        teller = a;
      }
    }
    if (teller && where) teller.news(`${cause.replace(agent.name, agent.name.replace(this.config.population.namePrefix, ''))} near ${Math.floor(where.x)} ${Math.floor(where.y)} ${Math.floor(where.z)}. Careful!`.slice(0, 100));
    if (alive === 0) void this.tick();
  }

  private onDisconnect(agent: BotAgent, reason: string): void {
    if (this.stopping || agent.isDead) return;
    const rec = this.state.get(agent.name);
    if (!rec || rec.status !== 'alive') return;
    this.agents.delete(agent.name);
    const delay = this.config.bot.reconnectDelaySeconds * 1000;
    log('warn', 'life', `${agent.name} disconnected (${reason}); reconnecting in ${delay / 1000}s`);
    setTimeout(() => {
      if (!this.stopping && this.state.get(agent.name)?.status === 'alive' && !this.agents.has(agent.name)) {
        this.launch(rec.name, rec.tier, rec.bed ?? null);
      }
    }, delay);
  }
}
