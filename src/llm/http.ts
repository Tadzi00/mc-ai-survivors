import { LLMError } from './types.js';

export interface HttpOptions {
  timeoutMs: number;
  retries: number;
  fetchImpl?: typeof fetch;
  /** Base delay for exponential backoff; tests set 0. */
  backoffMs?: number;
}

/** POST JSON with timeout and retries on network errors / 408 / 429 / 5xx. */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  opts: HttpOptions,
): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch;
  const backoff = opts.backoffMs ?? 1000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (attempt > 0 && backoff > 0) await new Promise((r) => setTimeout(r, backoff * 2 ** (attempt - 1)));
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        throw new LLMError(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`, retryable);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new LLMError(`non-JSON response from ${url}: ${text.slice(0, 200)}`, true);
      }
    } catch (e) {
      lastErr = e;
      if (e instanceof LLMError && !e.retryable) throw e;
    }
  }
  if (lastErr instanceof LLMError) throw lastErr;
  throw new LLMError(`request to ${url} failed: ${String(lastErr)}`, true);
}
