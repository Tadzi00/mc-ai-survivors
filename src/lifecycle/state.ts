import path from 'node:path';
import type { BedPos } from '../contracts.js';
import { readJsonFile, writeJsonFile } from '../util/fsjson.js';
import type { Tier } from './policy.js';

export interface BotRecord {
  name: string;
  tier: Tier;
  status: 'alive' | 'dead';
  bornAt: string;
  diedAt?: string;
  deathCause?: string;
  bed?: BedPos | null;
}

export interface OrchestratorStateData {
  version: 1;
  nameCounter: number;
  bots: BotRecord[];
}

/** Orchestrator state persisted to state/orchestrator.json so restarts resume the same population. */
export class OrchestratorState {
  private data: OrchestratorStateData;
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'orchestrator.json');
    this.data = readJsonFile<OrchestratorStateData>(this.file) ?? { version: 1, nameCounter: 0, bots: [] };
  }

  get bots(): readonly BotRecord[] {
    return this.data.bots;
  }

  get nameCounter(): number {
    return this.data.nameCounter;
  }

  set nameCounter(n: number) {
    this.data.nameCounter = n;
  }

  alive(): BotRecord[] {
    return this.data.bots.filter((b) => b.status === 'alive');
  }

  usedNames(): Set<string> {
    return new Set(this.data.bots.map((b) => b.name.toLowerCase()));
  }

  get(name: string): BotRecord | undefined {
    return this.data.bots.find((b) => b.name === name);
  }

  add(rec: BotRecord): void {
    this.data.bots.push(rec);
    this.save();
  }

  markDead(name: string, cause: string): BotRecord | undefined {
    const b = this.get(name);
    if (!b || b.status === 'dead') return undefined;
    b.status = 'dead';
    b.diedAt = new Date().toISOString();
    b.deathCause = cause;
    this.save();
    return b;
  }

  save(): void {
    writeJsonFile(this.file, this.data);
  }
}
