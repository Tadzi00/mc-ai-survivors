import { postJson, type HttpOptions } from './http.js';
import { LLMError, type CompletionRequest, type CompletionResult, type LLMProvider } from './types.js';

export interface OllamaOptions extends HttpOptions {
  baseUrl: string;
  keepAlive?: string;
  /** Context window (num_ctx). Unset = Ollama's default (often 4096). */
  numCtx?: number;
}

/** Ollama native API (/api/chat). Works for a local container or a remote Ollama server. */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';

  constructor(private readonly opts: OllamaOptions) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      stream: false,
      format: 'json',
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      options: { temperature: req.temperature, num_predict: req.maxTokens, ...(this.opts.numCtx ? { num_ctx: this.opts.numCtx } : {}) },
    };
    if (this.opts.keepAlive) body.keep_alive = this.opts.keepAlive;
    const res = (await postJson(`${this.opts.baseUrl.replace(/\/$/, '')}/api/chat`, body, {}, this.opts)) as {
      message?: { content?: string };
      error?: string;
      prompt_eval_count?: number;
      prompt_eval_duration?: number;
      eval_count?: number;
      eval_duration?: number;
    };
    if (res.error) throw new LLMError(`ollama: ${res.error}`, false);
    const text = res.message?.content;
    if (typeof text !== 'string') throw new LLMError('ollama: missing message.content', true);
    const ms = (ns?: number): number | undefined => (ns === undefined ? undefined : Math.round(ns / 1e6));
    return {
      text,
      stats: { promptTokens: res.prompt_eval_count, outputTokens: res.eval_count, promptMs: ms(res.prompt_eval_duration), outputMs: ms(res.eval_duration) },
    };
  }
}
