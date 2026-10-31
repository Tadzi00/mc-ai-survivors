import {
  isUnknownCommand,
  parseBeds,
  parseCanSpawn,
  parseSeasons,
  type BedPos,
  type BedsResult,
  type CanSpawnResult,
  type SeasonsReading,
} from '../contracts.js';
import { log } from '../util/log.js';
import type { CommandRunner } from './rcon.js';

/** Minecraft player names: 3-16 chars [A-Za-z0-9_]. Guard every name we interpolate into a command. */
export const isSafeName = (n: string): boolean => /^[A-Za-z0-9_]{1,16}$/.test(n);
const int = (n: number): number => Math.floor(n);

/** Typed wrapper around the SurvivorsBridge plugin's RCON commands (SB|v1 contract). */
export class BridgeApi {
  constructor(private readonly rcon: CommandRunner) {}

  async canSpawn(living: string[]): Promise<CanSpawnResult | undefined> {
    const names = living.filter(isSafeName);
    const out = await this.rcon.send(`survivors canspawn raw ${names.length ? names.join(',') : '-'}`);
    const r = parseCanSpawn(out);
    if (!r) log('warn', 'bridge', `unexpected canspawn output: ${out.slice(0, 200)}`);
    return r;
  }

  async beds(): Promise<BedsResult | undefined> {
    return parseBeds(await this.rcon.send('survivors beds raw'));
  }

  async assign(bot: string, bed: BedPos): Promise<boolean> {
    if (!isSafeName(bot) || !/^[\w\-:./]+$/.test(bed.world)) return false;
    const out = await this.rcon.send(`survivors assign ${bot} ${bed.x} ${bed.y} ${bed.z} ${bed.world}`);
    return out.includes('"ok":true');
  }

  async unassign(bot: string): Promise<void> {
    if (isSafeName(bot)) await this.rcon.send(`survivors unassign ${bot}`);
  }

  /** Adds a bot to the server whitelist (offline-mode servers should run with a whitelist). */
  async whitelistAdd(bot: string): Promise<void> {
    if (isSafeName(bot)) await this.rcon.send(`whitelist add ${bot}`);
  }

  /** Starts the "no hostile mobs" grace period (bridge plugin; default one Minecraft day). */
  async graceStart(ticks?: number): Promise<void> {
    await this.rcon.send(ticks === undefined ? 'survivors grace start' : `survivors grace start ${Math.max(0, Math.floor(ticks))}`);
  }

  /** Puts a newborn bot at its bed: spawnpoint + teleport (bots are not op; RCON is). */
  async placeAtBed(bot: string, bed: BedPos): Promise<void> {
    if (!isSafeName(bot)) return;
    await this.rcon.send(`spawnpoint ${bot} ${bed.x} ${bed.y} ${bed.z}`);
    await this.rcon.send(`execute in ${worldToDimension(bed.world)} run tp ${bot} ${bed.x + 0.5} ${bed.y + 1} ${bed.z + 0.5}`);
  }
}

function worldToDimension(world: string): string {
  if (world.endsWith('_nether')) return 'minecraft:the_nether';
  if (world.endsWith('_the_end')) return 'minecraft:the_end';
  return 'minecraft:overworld';
}

/**
 * Typed wrapper around RealisticSeasons' /temp raw and /room raw (RS|v1 contract).
 * If the plugin is missing (unknown command), seasons are reported as disabled and we stop asking.
 */
export class SeasonsApi {
  private disabled = false;

  constructor(private readonly rcon: CommandRunner) {}

  get enabled(): boolean {
    return !this.disabled;
  }

  async temp(x: number, y: number, z: number, world?: string): Promise<SeasonsReading | undefined> {
    return this.query('temp', x, y, z, world);
  }

  async room(x: number, y: number, z: number, world?: string): Promise<SeasonsReading | undefined> {
    return this.query('room', x, y, z, world);
  }

  private async query(
    kind: 'temp' | 'room',
    x: number,
    y: number,
    z: number,
    world?: string,
  ): Promise<SeasonsReading | undefined> {
    if (this.disabled) return undefined;
    const w = world && /^[\w\-:./]+$/.test(world) ? ` ${world}` : '';
    let out: string;
    try {
      out = await this.rcon.send(`${kind} raw ${int(x)} ${int(y)} ${int(z)}${w}`);
    } catch (e) {
      log('debug', 'seasons', `rcon failed: ${String(e)}`);
      return undefined;
    }
    const r = parseSeasons(out, kind);
    if (!r && isUnknownCommand(out)) {
      this.disabled = true;
      log('info', 'seasons', 'RealisticSeasons not detected (/temp raw unknown) — seasons disabled');
    }
    return r;
  }
}
