import { postJson, type HttpOptions } from './http.js';
import { LLMError, type CompletionRequest, type CompletionResult, type LLMProvider } from './types.js';

export interface AnthropicOptions extends HttpOptions {
  baseUrl: string;
  apiKey: string;
  effort?: 'low' | 'medium' | 'high';
}

/**
 * Anthropic Messages API via plain fetch (keeps the provider layer dependency-free and uniform).
 * `temperature` is intentionally NOT sent: current Claude models (e.g. claude-sonnet-5-5,
 * claude-haiku-5-5) reject non-default sampling parameters. Only `text` blocks are returned;
 * thinking blocks are ignored.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';

  constructor(private readonly opts: AnthropicOptions) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
    };
    if (this.opts.effort) body.output_config = { effort: this.opts.effort };
    const res = (await postJson(
      `${this.opts.baseUrl.replace(/\/$/, '')}/v1/messages`,
      body,
      { 'x-api-key': this.opts.apiKey, 'anthropic-version': '2023-06-01' },
      this.opts,
    )) as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
    if (res.stop_reason === 'refusal') throw new LLMError('anthropic: model refused', false);
    const text = (res.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    if (!text) throw new LLMError('anthropic: no text content in response', true);
    return { text };
  }
}
