/**
 * Credit + rate-limit response header handling.
 *
 * Header bags are mocked as Maps, matching the pattern in api.test.js.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readResponseMeta, creditWarning } from '../response-meta.js';
import { NansenAPI, RESPONSE_META, ErrorCode } from '../api.js';

function headers(entries) {
  const map = new Map(Object.entries(entries));
  return { get: name => (map.has(name) ? map.get(name) : null) };
}

describe('readResponseMeta', () => {
  it('parses credit and rate-limit headers', () => {
    const meta = readResponseMeta({
      headers: headers({
        'x-nansen-credits-used': '5',
        'x-nansen-credits-remaining': '41230',
        'x-ratelimit-limit': '1500',
        'x-ratelimit-remaining': '1499',
        'x-ratelimit-reset': '60',
      }),
    });

    expect(meta).toEqual({
      credits: { used: 5, remaining: 41230 },
      rateLimit: { limit: 1500, remaining: 1499, resetSeconds: 60 },
    });
  });

  it('returns null when no relevant headers are present', () => {
    expect(readResponseMeta({ headers: headers({}) })).toBeNull();
  });

  it('tolerates a response with no headers at all', () => {
    // Most existing success-path mocks look like this.
    expect(readResponseMeta({ ok: true })).toBeNull();
    expect(readResponseMeta(undefined)).toBeNull();
  });

  it('omits the section whose headers are missing', () => {
    const creditsOnly = readResponseMeta({
      headers: headers({ 'x-nansen-credits-used': '5', 'x-nansen-credits-remaining': '0' }),
    });
    expect(creditsOnly).toEqual({ credits: { used: 5, remaining: 0 } });
    expect(creditsOnly.rateLimit).toBeUndefined();

    const rateOnly = readResponseMeta({ headers: headers({ 'x-ratelimit-remaining': '3' }) });
    expect(rateOnly).toEqual({ rateLimit: { limit: null, remaining: 3, resetSeconds: null } });
    expect(rateOnly.credits).toBeUndefined();
  });

  it('reads zero as a value, not as absent', () => {
    const meta = readResponseMeta({
      headers: headers({ 'x-nansen-credits-used': '0', 'x-nansen-credits-remaining': '0' }),
    });
    expect(meta.credits).toEqual({ used: 0, remaining: 0 });
  });

  it('treats unparseable or negative values as unknown', () => {
    const meta = readResponseMeta({
      headers: headers({
        'x-nansen-credits-used': 'abc',
        'x-nansen-credits-remaining': '',
        'x-ratelimit-limit': '-1',
      }),
    });
    expect(meta).toBeNull();
  });
});

describe('creditWarning', () => {
  it('warns when the balance is exhausted', () => {
    const warning = creditWarning({ credits: { used: 5, remaining: 0 } });
    expect(warning).toContain('Out of API credits');
  });

  it('warns when the balance will not cover another call of the same size', () => {
    const warning = creditWarning({ credits: { used: 10, remaining: 3 } });
    expect(warning).toContain('3 API credits left');
    expect(warning).toContain('less than this call cost (10)');
  });

  it('singularises one remaining credit', () => {
    expect(creditWarning({ credits: { used: 5, remaining: 1 } })).toContain('1 API credit left');
  });

  it('stays silent when the balance is comfortable', () => {
    expect(creditWarning({ credits: { used: 5, remaining: 41230 } })).toBeNull();
  });

  it('stays silent when remaining is unknown', () => {
    expect(creditWarning({ credits: { used: 5, remaining: null } })).toBeNull();
    expect(creditWarning({ rateLimit: { limit: 1500, remaining: 1, resetSeconds: 60 } })).toBeNull();
    expect(creditWarning(null)).toBeNull();
  });

  it('stays silent for free endpoints, which charge nothing', () => {
    expect(creditWarning({ credits: { used: 0, remaining: 5 } })).toBeNull();
  });
});

describe('NansenAPI response metadata', () => {
  let mockFetch;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches metadata to a successful response without changing its JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ netflows: [{ token_symbol: 'TEST' }] }),
      headers: headers({
        'x-nansen-credits-used': '5',
        'x-nansen-credits-remaining': '41230',
        'x-ratelimit-limit': '1500',
        'x-ratelimit-remaining': '1499',
        'x-ratelimit-reset': '60',
      }),
    });

    const api = new NansenAPI('test-key');
    const result = await api.smartMoneyNetflow({ chains: ['solana'] });

    expect(result[RESPONSE_META]).toEqual({
      credits: { used: 5, remaining: 41230 },
      rateLimit: { limit: 1500, remaining: 1499, resetSeconds: 60 },
    });
    expect(api.lastResponseMeta).toEqual(result[RESPONSE_META]);
    // The symbol must be invisible to the JSON every command prints.
    expect(JSON.stringify(result)).toBe('{"netflows":[{"token_symbol":"TEST"}]}');
    expect(Object.keys(result)).toEqual(['netflows']);
  });

  it('leaves a header-less success response untouched', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ netflows: [] }) });

    const api = new NansenAPI('test-key');
    const result = await api.smartMoneyNetflow({ chains: ['solana'] });

    expect(result[RESPONSE_META]).toBeUndefined();
    expect(api.lastResponseMeta).toBeNull();
  });

  it('puts the balance on an out-of-credits error, where it matters most', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Insufficient credits', detail: 'Not enough credits' }),
      headers: headers({ 'x-nansen-credits-used': '0', 'x-nansen-credits-remaining': '2' }),
    });

    const api = new NansenAPI('test-key');
    await expect(api.smartMoneyNetflow({ chains: ['solana'] })).rejects.toMatchObject({
      code: ErrorCode.CREDITS_EXHAUSTED,
      details: { credits: { used: 0, remaining: 2 } },
    });
  });

  it('puts rate-limit state on a 429', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ detail: 'Rate limit exceeded.', retry_after: 60 }),
      headers: headers({
        'retry-after': '60',
        'x-ratelimit-limit': '1500',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '60',
      }),
    });

    // maxRetries: 0 — a 429 is retryable, and the real client would honour the
    // 60s Retry-After before giving up.
    const api = new NansenAPI('test-key', undefined, { retry: { maxRetries: 0 } });
    await expect(
      api.smartMoneyNetflow({ chains: ['solana'] })
    ).rejects.toMatchObject({
      code: ErrorCode.RATE_LIMITED,
      details: {
        retryAfterMs: 60000,
        rateLimit: { limit: 1500, remaining: 0, resetSeconds: 60 },
      },
    });
  });
});
