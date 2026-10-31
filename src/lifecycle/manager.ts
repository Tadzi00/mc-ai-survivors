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

  private async tick(): Promise<void> {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
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
      const decision = decideSpawn({
        aliveCount: alive.length,
        maxBots: p.maxBots,
        initialBots: p.initialBots,
        reseedWhenExtinct: p.reseedWhenExtinct,
        everSpawned: this.state.bots.length > 0,
        canSpawn,
      });
      if (decision.action === 'none') {
        log('debug', 'life', `no spawn: ${decision.reason}${canSpawn?.missing.length ? ` (missing beds: ${canSpawn.missing.join(',')})` : ''}`);
        return;
      }
      if (decision.action === 'seed') {
        const tiers = assignTiers([], p.smartSlots, decision.count);
        log('info', 'life', `${decision.reason}: spawning ${decision.count} bots`);
        this.jsonl.write('seed', { reason: decision.reason, count: decision.count });
        for (const tier of tiers) this.birth(tier, null);
        return;
      }
      const tier = assignTier(alive.map((b) => b.tier), p.smartSlots);
      const name = this.peekName();
      const ok = await this.bridge.assign(name, decision.bed);
      if (!ok) {
        log('warn', 'life', `could not assign bed ${JSON.stringify(decision.bed)} to ${name}`);
        return;
      }
      log('info', 'life', `shelter rule met -> newborn ${name} (${tier}) at bed ${decision.bed.x},${decision.bed.y},${decision.bed.z}`);
      this.birth(tier, decision.bed, name);
    } finally {
      this.ticking = false;
    }
  }

  private peekName(): string {
    return nextBotName(this.config.population.namePrefix, this.state.nameCounter, this.state.usedNames()).name;
  }

  private birth(tier: Tier, bed: BedPos | null, presetName?: string): void {
    const n = nextBotName(this.config.population.namePrefix, this.state.nameCounter, this.state.usedNames());
    const name = presetName ?? n.name;
    this.state.nameCounter = n.counter;
    this.state.add({ name, tier, status: 'alive', bornAt: new Date().toISOString(), bed });
    this.jsonl.write('birth', { name, tier, bed });
    if (bed && this.config.population.spawnAtBed) this.newborns.set(name, bed);
    this.launch(name, tier, bed);
  }

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
    void ready.then(() => {
      if (!this.stopping && this.agents.get(name) === agent) agent.start();
    });
  }

  private async onSpawn(agent: BotAgent): Promise<void> {
    const bed = this.newborns.get(agent.name);
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
