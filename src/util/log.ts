import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: Level = (process.env.LOG_LEVEL as Level | undefined) ?? 'info';

export function setLogLevel(level: Level): void {
  minLevel = level;
}

/** Concise console logger. */
export function log(level: Level, scope: string, msg: string): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const line = `${new Date().toISOString().slice(11, 19)} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const shortHash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 10);

/** Append-only JSONL event log, one file per bot (or "orchestrator"). */
export class JsonlLog {
  private readonly file: string;

  constructor(dir: string, name: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${name}.jsonl`);
  }

  write(event: string, data: Record<string, unknown> = {}): void {
    try {
      appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n');
    } catch (e) {
      log('warn', 'jsonl', `cannot write ${this.file}: ${String(e)}`);
    }
  }
}
