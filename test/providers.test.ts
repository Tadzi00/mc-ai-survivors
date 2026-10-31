import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { createProvider, QueuedProvider } from '../src/llm/factory.js';
import { OllamaProvider } from '../src/llm/ollama.js';
import { OpenAICompatibleProvider } from '../src/llm/openai.js';
import { RequestQueue } from '../src/llm/queue.js';
import type { LLMProvider } from '../src/llm/types.js';

const req = { system: 'sys', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 100, temperature: 0.3, model: 'm' };

function mockFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const r = responses.shift()!;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('ollama', () => {
  it('posts to /api/chat with format json and returns message.content', async () => {
    const m = mockFetch([{ status: 200, body: { message: { content: '{"skill":"wait"}' } } }]);
    const p = new OllamaProvider({ baseUrl: 'http://gpu:11434/', timeoutMs: 1000, retries: 0, fetchImpl: m.fn, keepAlive: '30m' });
    const r = await p.complete(req);
    expect(r.text).toBe('{"skill":"wait"}');
    expect(m.calls[0]!.url).toBe('http://gpu:11434/api/chat');
    const body = JSON.parse(m.calls[0]!.init.body as string);
    expect(body).toMatchObject({ model: 'm', stream: false, format: 'json', keep_alive: '30m', options: { num_predict: 100, temperature: 0.3 } });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });
  it('retries on 500 then succeeds', async () => {
    const m = mockFetch([
      { status: 500, body: 'boom' },
      { status: 200, body: { message: { content: 'ok' } } },
    ]);
    const p = new OllamaProvider({ baseUrl: 'http://x', timeoutMs: 1000, retries: 1, fetchImpl: m.fn, backoffMs: 0 });
    expect((await p.complete(req)).text).toBe('ok');
    expect(m.calls).toHaveLength(2);
  });
  it('does not retry 400', async () => {
    const m = mockFetch([{ status: 400, body: 'bad' }]);
    const p = new OllamaProvider({ baseUrl: 'http://x', timeoutMs: 1000, retries: 3, fetchImpl: m.fn, backoffMs: 0 });
    await expect(p.complete(req)).rejects.toThrow(/HTTP 400/);
    expect(m.calls).toHaveLength(1);
  });
});

describe('openai-compatible', () => {
  it('sends bearer key and json mode, reads choices[0]', async () => {
    const m = mockFetch([{ status: 200, body: { choices: [{ message: { content: 'hello' } }] } }]);
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', jsonMode: true, timeoutMs: 1000, retries: 0, fetchImpl: m.fn });
    expect((await p.complete(req)).text).toBe('hello');
    expect(m.calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((m.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(m.calls[0]!.init.body as string)).toMatchObject({ response_format: { type: 'json_object' }, max_tokens: 100 });
  });
  it('omits auth and json mode when not configured', async () => {
    const m = mockFetch([{ status: 200, body: { choices: [{ message: { content: 'x' } }] } }]);
    const p = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:1234/v1', jsonMode: false, timeoutMs: 1000, retries: 0, fetchImpl: m.fn });
    await p.complete(req);
    expect((m.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(m.calls[0]!.init.body as string).response_format).toBeUndefined();
  });
});

describe('anthropic', () => {
  it('uses the Messages API, no temperature, joins text blocks', async () => {
    const m = mockFetch([{ status: 200, body: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"a"' }, { type: 'text', text: ':1}' }], stop_reason: 'end_turn' } }]);
    const p = new AnthropicProvider({ baseUrl: 'https://api.anthropic.com', apiKey: 'sk', effort: 'low', timeoutMs: 1000, retries: 0, fetchImpl: m.fn });
    expect((await p.complete({ ...req, model: 'claude-haiku-5-5' })).text).toBe('{"a":1}');
    const call = m.calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    const h = call.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk');
    expect(h['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(call.init.body as string);
    expect(body).toMatchObject({ model: 'claude-haiku-5-5', system: 'sys', max_tokens: 100, output_config: { effort: 'low' } });
    expect(body.temperature).toBeUndefined();
  });
  it('throws on refusal', async () => {
    const m = mockFetch([{ status: 200, body: { content: [], stop_reason: 'refusal' } }]);
    const p = new AnthropicProvider({ baseUrl: 'https://api.anthropic.com', apiKey: 'sk', timeoutMs: 1000, retries: 0, fetchImpl: m.fn });
    await expect(p.complete(req)).rejects.toThrow(/refused/);
  });
  it('factory requires the api key env var', () => {
    expect(() =>
      createProvider({ type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'NOPE_KEY', concurrency: 1, timeoutMs: 1000, retries: 0 }, {}),
    ).toThrow(/NOPE_KEY/);
  });
});

describe('queue', () => {
  it('limits concurrency', async () => {
    const q = new RequestQueue(1);
    let active = 0;
    let maxActive = 0;
    const job = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all([q.run(job), q.run(job), q.run(job)]);
    expect(maxActive).toBe(1);
  });
  it('QueuedProvider delegates', async () => {
    const inner: LLMProvider = { name: 'x', complete: async () => ({ text: 'ok' }) };
    expect((await new QueuedProvider(inner, 2).complete(req)).text).toBe('ok');
  });
});
