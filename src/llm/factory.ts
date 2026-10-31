import type { Config, ProviderConfig, TierConfig } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai.js';
import { RequestQueue } from './queue.js';
import type { CompletionRequest, CompletionResult, LLMProvider } from './types.js';

export type Tier = 'smart' | 'basic';

/** Wraps a provider with its per-provider request queue. */
export class QueuedProvider implements LLMProvider {
  readonly name: string;
  private readonly queue: RequestQueue;

  constructor(
    private readonly inner: LLMProvider,
    concurrency: number,
  ) {
    this.name = inner.name;
    this.queue = new RequestQueue(concurrency);
  }

  complete(req: CompletionRequest): Promise<CompletionResult> {
    return this.queue.run(() => this.inner.complete(req));
  }
}

export function createProvider(cfg: ProviderConfig, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): LLMProvider {
  const http = { timeoutMs: cfg.timeoutMs, retries: cfg.retries, fetchImpl };
  switch (cfg.type) {
    case 'ollama':
      return new OllamaProvider({ ...http, baseUrl: cfg.baseUrl, keepAlive: cfg.keepAlive, numCtx: cfg.numCtx });
    case 'openai-compatible':
      return new OpenAICompatibleProvider({
        ...http,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKeyEnv ? env[cfg.apiKeyEnv] : undefined,
        jsonMode: cfg.jsonMode,
      });
    case 'anthropic': {
      const apiKey = env[cfg.apiKeyEnv];
      if (!apiKey) throw new Error(`anthropic provider: env var ${cfg.apiKeyEnv} is not set`);
      return new AnthropicProvider({ ...http, baseUrl: cfg.baseUrl, apiKey, effort: cfg.effort });
    }
  }
}

/** One queued provider instance per configured provider name (shared by all bots). */
export class LLMRegistry {
  private readonly providers = new Map<string, QueuedProvider>();

  constructor(private readonly config: Config) {}

  forTier(tier: Tier): { provider: LLMProvider; tier: TierConfig } {
    const tierCfg = this.config.tiers[tier];
    let p = this.providers.get(tierCfg.provider);
    if (!p) {
      const pc = this.config.providers[tierCfg.provider];
      if (!pc) throw new Error(`unknown provider ${tierCfg.provider}`);
      p = new QueuedProvider(createProvider(pc), pc.concurrency);
      this.providers.set(tierCfg.provider, p);
    }
    return { provider: p, tier: tierCfg };
  }
}
