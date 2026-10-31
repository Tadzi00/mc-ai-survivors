import { loadConfig } from './config.js';
import { LifecycleManager } from './lifecycle/manager.js';
import { OrchestratorState } from './lifecycle/state.js';
import { LLMRegistry } from './llm/factory.js';
import { RconClient } from './rcon/rcon.js';
import { BridgeApi, SeasonsApi } from './rcon/server.js';
import { log } from './util/log.js';
import { HomeRegistry, ProtectedAreas, Roster } from './bot/chat.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const rcon = new RconClient(config.rcon);
  const bridge = new BridgeApi(rcon);
  const seasons = new SeasonsApi(rcon);
  const llm = new LLMRegistry(config);
  // Fail fast on provider misconfiguration (e.g. missing API key).
  llm.forTier('smart');
  llm.forTier('basic');

  // Probe RCON + plugins once so problems are visible at startup.
  try {
    const beds = await bridge.beds();
    log('info', 'main', beds ? `SurvivorsBridge OK (${beds.beds.length} beds indexed)` : 'SurvivorsBridge NOT detected - population will not grow');
  } catch (e) {
    log('warn', 'main', `RCON not reachable yet (${String(e)}); will retry on each poll`);
  }

  const protectedAreas = new ProtectedAreas();
  const refreshAreas = (): void => {
    void bridge
      .areas()
      .then((a) => {
        if (a) protectedAreas.list = a;
      })
      .catch(() => undefined);
  };
  refreshAreas();
  setInterval(refreshAreas, 60_000);

  const state = new OrchestratorState(config.paths.state);
  const manager = new LifecycleManager(config, state, bridge, { config, llm, seasons, roster: new Roster(), rcon, protectedAreas, homes: new HomeRegistry() });
  manager.start();
  log('info', 'main', `orchestrator running: max ${config.population.maxBots} bots, ${config.population.smartSlots} smart slots`);

  const shutdown = (): void => {
    log('info', 'main', 'shutting down');
    manager.stop();
    void rcon.close().finally(() => setTimeout(() => process.exit(0), 500));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e: unknown) => {
  log('error', 'main', e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
