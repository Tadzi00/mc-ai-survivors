import { postJson, type HttpOptions } from './http.js';
import { LLMError, type CompletionRequest, type CompletionResult, type LLMProvider } from './types.js';

export interface OpenAICompatibleOptions extends HttpOptions {
  baseUrl: string;
  apiKey?: string;
  jsonMode: boolean;
}

/** Any OpenAI-compatible /chat/completions endpoint: OpenAI, OpenRouter, LM Studio, vLLM, llama.cpp... */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = 'openai-compatible';

  constructor(private readonly opts: OpenAICompatibleOptions) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
    };
    if (this.opts.jsonMode) body.response_format = { type: 'json_object' };
    const headers: Record<string, string> = {};
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const res = (await postJson(
      `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`,
      body,
      headers,
      this.opts,
    )) as { choices?: Array<{ message?: { content?: string | null } }> };
    const text = res.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new LLMError('openai-compatible: missing choices[0].message.content', true);
    return { text };
  }
}
