import { postJson, type HttpOptions } from './http.js';
import { LLMError, type CompletionRequest, type CompletionResult, type LLMProvider } from './types.js';

export interface OllamaOptions extends HttpOptions {
  baseUrl: string;
  keepAlive?: string;
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
      options: { temperature: req.temperature, num_predict: req.maxTokens },
    };
    if (this.opts.keepAlive) body.keep_alive = this.opts.keepAlive;
    const res = (await postJson(`${this.opts.baseUrl.replace(/\/$/, '')}/api/chat`, body, {}, this.opts)) as {
      message?: { content?: string };
      error?: string;
    };
    if (res.error) throw new LLMError(`ollama: ${res.error}`, false);
    const text = res.message?.content;
    if (typeof text !== 'string') throw new LLMError('ollama: missing message.content', true);
    return { text };
  }
}
