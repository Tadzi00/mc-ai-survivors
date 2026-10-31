import type { Bot } from 'mineflayer';
import type { Config } from '../config.js';
import type { Memory } from '../bot/memory.js';
import type { SeasonsApi } from '../rcon/server.js';
import type { Tier } from '../lifecycle/policy.js';

export interface SkillContext {
  bot: Bot;
  name: string;
  tier: Tier;
  memory: Memory;
  seasons: SeasonsApi;
  config: Config;
  /** Aborted when a reflex interrupts, the skill times out, or the bot dies. */
  signal: AbortSignal;
  log: (msg: string) => void;
}

export type SkillFn<A> = (ctx: SkillContext, args: A) => Promise<string>;
