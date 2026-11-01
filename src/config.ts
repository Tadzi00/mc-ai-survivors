import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const common = {
  /** Max parallel requests to this provider (1 is right for a single local GPU). */
  concurrency: z.number().int().min(1).default(1),
  timeoutMs: z.number().int().min(1000).default(60_000),
  retries: z.number().int().min(0).max(10).default(2),
};

export const ProviderSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ollama'),
    baseUrl: z.string().url().default('http://localhost:11434'),
    /** How long Ollama keeps the model loaded (e.g. "30m"). */
    keepAlive: z.string().optional(),
    /** Context window in tokens (num_ctx); unset = Ollama default (often 4096). Bigger = more VRAM. */
    numCtx: z.number().int().min(1024).optional(),
    ...common,
  }),
  z.object({
    type: z.literal('openai-compatible'),
    baseUrl: z.string().url(),
    /** Name of the env var holding the API key (optional for local servers like LM Studio). */
    apiKeyEnv: z.string().optional(),
    /** Send response_format: json_object (disable for servers that reject it). */
    jsonMode: z.boolean().default(true),
    ...common,
  }),
  z.object({
    type: z.literal('anthropic'),
    baseUrl: z.string().url().default('https://api.anthropic.com'),
    apiKeyEnv: z.string().default('ANTHROPIC_API_KEY'),
    /** output_config.effort; low keeps latency/cost down for one-action decisions. */
    effort: z.enum(['low', 'medium', 'high']).optional(),
    ...common,
  }),
]);
export type ProviderConfig = z.infer<typeof ProviderSchema>;

export const TierSchema = z.object({
  provider: z.string(),
  model: z.string(),
  maxTokens: z.number().int().min(64).default(400),
  /** Ignored by the anthropic provider (newer Claude models reject non-default sampling). */
  temperature: z.number().min(0).max(2).default(0.4),
});
export type TierConfig = z.infer<typeof TierSchema>;

export const ConfigSchema = z
  .object({
    server: z
      .object({
        host: z.string().default('localhost'),
        port: z.number().int().default(25565),
        /** Minecraft version string, or "auto" to let mineflayer detect it. */
        version: z.string().default('1.21.4'),
      })
      .default({}),
    rcon: z
      .object({
        host: z.string().default('localhost'),
        port: z.number().int().default(25575),
        password: z.string().default(''),
        timeoutMs: z.number().int().default(5000),
      })
      .default({}),
    population: z
      .object({
        maxBots: z.number().int().min(1).default(8),
        smartSlots: z.number().int().min(0).default(2),
        initialBots: z.number().int().min(1).default(2),
        reseedWhenExtinct: z.boolean().default(true),
        spawnPollSeconds: z.number().min(2).default(30),
        namePrefix: z.string().regex(/^[A-Za-z0-9_]{1,12}$/).default('Surv_'),
        /** Teleport a newborn bot to its free bed and set its spawnpoint there (via RCON). */
        spawnAtBed: z.boolean().default(true),
        /** Run `whitelist add <bot>` over RCON before each bot connects. */
        autoWhitelist: z.boolean().default(true),
        graceOnSeed: z.boolean().default(true),
      })
      .default({}),
    /** Blocks; bots only "hear" chat from players within this distance. */
    chatRange: z.number().min(1).default(15),
    shout: z
      .object({
        range: z.number().min(1).default(1000),
        maxWords: z.number().int().min(1).default(15),
        cooldownSeconds: z.number().min(0).default(60),
      })
      .default({}),
    bot: z
      .object({
        plannerMinIntervalSeconds: z.number().min(0).default(6),
        reflexIntervalMs: z.number().int().min(100).default(500),
        skillTimeoutSeconds: z.number().min(5).default(120),
        serverCrafting: z.boolean().default(true),
        /** Go home / dig a bunker at night when outdoors (see DESIGN.md 6.5.4). */
        nightShelter: z.boolean().default(true),
        scanRadius: z.number().int().min(4).max(64).default(24),
        coldThresholdC: z.number().default(5),
        temperatureCheckSeconds: z.number().min(5).default(30),
        notesMax: z.number().int().min(5).default(40),
        chatHistory: z.number().int().min(1).default(8),
        reconnectDelaySeconds: z.number().min(1).default(10),
      })
      .default({}),
    providers: z.record(z.string(), ProviderSchema),
    tiers: z.object({ smart: TierSchema, basic: TierSchema }),
    paths: z
      .object({ state: z.string().default('./state'), logs: z.string().default('./logs') })
      .default({}),
  })
  .superRefine((c, ctx) => {
    for (const tier of ['smart', 'basic'] as const) {
      if (!c.providers[c.tiers[tier].provider]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tiers', tier, 'provider'],
          message: `unknown provider "${c.tiers[tier].provider}"`,
        });
      }
    }
    if (c.population.smartSlots > c.population.maxBots) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['population', 'smartSlots'], message: 'smartSlots > maxBots' });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

/** Replaces ${VAR} and ${VAR:-default} in all string values (lets docker-compose env drive the YAML). */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') {
    const full = /^\$\{([A-Z0-9_]+)(?::-([^}]*))?\}$/.exec(value);
    if (full) {
      const v = env[full[1]!] ?? full[2];
      if (v === undefined) return value;
      // Keep numbers/booleans typed when the whole value is a placeholder.
      if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
      if (v === 'true' || v === 'false') return v === 'true';
      return v;
    }
    return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, k: string, d?: string) => env[k] ?? d ?? '');
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env)]));
  }
  return value;
}

export function parseConfig(yamlText: string, env: NodeJS.ProcessEnv = process.env): Config {
  const raw = interpolateEnv(parseYaml(yamlText) ?? {}, env);
  return ConfigSchema.parse(raw);
}

export function loadConfig(file = process.env.CONFIG_FILE ?? 'config.yaml'): Config {
  const path = existsSync(file) ? file : 'config.example.yaml';
  if (!existsSync(path)) throw new Error(`config file not found: ${file}`);
  return parseConfig(readFileSync(path, 'utf8'));
}
