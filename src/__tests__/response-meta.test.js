/**
 * Credit + rate-limit response header handling.
 *
 * Header bags are mocked as Maps, matching the pattern in api.test.js.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readResponseMeta, creditWarning, noticeWarnings } from '../response-meta.js';
import { NansenAPI, RESPONSE_META, ErrorCode } from '../api.js';

function headers(entries) {
  const map = new Map(Object.entries(entries));
  return { get: name => (map.has(name) ? map.get(name) : null) };
}

describe('readResponseMeta', () => {
  it('parses credit, rate-limit, and notice headers', () => {
    const meta = readResponseMeta({
      headers: headers({
        'x-nansen-credits-used': '5',
        'x-nansen-credits-remaining': '41230',
        'x-ratelimit-limit': '1500',
        'x-ratelimit-remaining': '1499',
        'x-ratelimit-reset': '60',
        'x-nansen-upgrade-hint': 'Upgrade to Pro',
        'x-nansen-plan-notice': 'Free tier resets at midnight UTC',
        'x-nansen-api-key-notice': 'Rotate your API key',
      }),
    });

    expect(meta).toEqual({
      credits: { used: 5, remaining: 41230 },
      rateLimit: { limit: 1500, remaining: 1499, resetSeconds: 60 },
      notices: {
        upgradeHint: 'Upgrade to Pro',
        planNotice: 'Free tier resets at midnight UTC',
        apiKeyNotice: 'Rotate your API key',
      },
    });
  });

  it('parses credit and rate-limit headers (no notices)', () => {
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

  it('includes only the notice keys that are present', () => {
    const meta = readResponseMeta({
      headers: headers({ 'x-nansen-upgrade-hint': 'Upgrade to Pro' }),
    });
    expect(meta).toEqual({ notices: { upgradeHint: 'Upgrade to Pro' } });
    expect(meta.notices.planNotice).toBeUndefined();
    expect(meta.notices.apiKeyNotice).toBeUndefined();
  });

  it('treats empty string notice headers as absent', () => {
    const meta = readResponseMeta({
      headers: headers({ 'x-nansen-upgrade-hint': '' }),
    });
    expect(meta).toBeNull();
  });

  it('trims whitespace from notice header values', () => {
    const meta = readResponseMeta({
      headers: headers({ 'x-nansen-api-key-notice': '  Rotate your key  ' }),
    });
    expect(meta.notices.apiKeyNotice).toBe('Rotate your key');
  });

  it('returns null when no relevant headers are present', () => {
    expect(readResponseMeta({ headers: headers({}) })).toBeNull();
  });

  it('parses the request id', () => {
    const meta = readResponseMeta({ headers: headers({ 'x-request-id': 'req-a1b2c3' }) });
    expect(meta).toEqual({ requestId: 'req-a1b2c3' });
  });

  it('keeps the request id opaque and trims surrounding whitespace', () => {
    // Any format the server chooses must survive untouched — gateway ids,
    // caller-forwarded ids and generated ids all look different.
    expect(
      readResponseMeta({ headers: headers({ 'x-request-id': '  8f14e45f-ea0a  ' }) })
    ).toEqual({ requestId: '8f14e45f-ea0a' });
    expect(readResponseMeta({ headers: headers({ 'x-request-id': '   ' }) })).toBeNull();
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

describe('noticeWarnings', () => {
  it('returns empty array when no notices', () => {
    expect(noticeWarnings(null)).toEqual([]);
    expect(noticeWarnings({ credits: { used: 5, remaining: 100 } })).toEqual([]);
  });

  it('emits ⚠️ for apiKeyNotice (most urgent)', () => {
    const warnings = noticeWarnings({ notices: { apiKeyNotice: 'Rotate your key by April 27' } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^⚠️/);
    expect(warnings[0]).toContain('Rotate your key by April 27');
  });

  it('emits ℹ️ for upgradeHint and planNotice', () => {
    const warnings = noticeWarnings({
      notices: { upgradeHint: 'Upgrade to Pro', planNotice: 'Free tier resets at midnight' },
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^ℹ️/);
    expect(warnings[0]).toContain('Upgrade to Pro');
    expect(warnings[1]).toMatch(/^ℹ️/);
    expect(warnings[1]).toContain('Free tier resets at midnight');
  });

  it('orders apiKeyNotice before upgradeHint before planNotice', () => {
    const warnings = noticeWarnings({
      notices: {
        planNotice: 'Plan notice',
        upgradeHint: 'Upgrade hint',
        apiKeyNotice: 'Key notice',
      },
    });
    expect(warnings[0]).toContain('Key notice');
    expect(warnings[1]).toContain('Upgrade hint');
    expect(warnings[2]).toContain('Plan notice');
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
        'x-request-id': 'req-a1b2c3',
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
      requestId: 'req-a1b2c3',
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
    api.lastResponseMeta = { requestId: 'req-stale' };
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

  it('puts the request id on a server error, where support needs it', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal server error' }),
      headers: headers({ 'x-request-id': 'req-deadbeef' }),
    });

    const api = new NansenAPI('test-key', undefined, { retry: { maxRetries: 0 } });
    await expect(api.smartMoneyNetflow({ chains: ['solana'] })).rejects.toMatchObject({
      code: ErrorCode.SERVER_ERROR,
      status: 500,
      details: { requestId: 'req-deadbeef' },
    });
  });

  it('omits requestId entirely when the response carries no id', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal server error' }),
      headers: headers({}),
    });

    const api = new NansenAPI('test-key', undefined, { retry: { maxRetries: 0 } });
    // Capture rather than .catch(assert) — a resolving call would skip the
    // assertion entirely and pass silently.
    const err = await api.smartMoneyNetflow({ chains: ['solana'] }).then(
      () => { throw new Error('expected the call to reject'); },
      e => e
    );
    expect(err.status).toBe(500);
    expect('requestId' in err.details).toBe(false);
  });

  it('puts the request id on a non-JSON gateway error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
      text: async () => '<html>Bad Gateway</html>',
      headers: headers({ 'x-request-id': 'req-gateway' }),
    });

    const api = new NansenAPI('test-key', undefined, { retry: { maxRetries: 0 } });
    await expect(api.smartMoneyNetflow({ chains: ['solana'] })).rejects.toMatchObject({
      code: ErrorCode.SERVER_ERROR,
      status: 502,
      details: {
        body: '<html>Bad Gateway</html>',
        requestId: 'req-gateway',
      },
    });
    expect(api.lastResponseMeta).toEqual({ requestId: 'req-gateway' });
  });

  it('clears stale metadata when the final retry has none', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'First failure' }),
        headers: headers({ 'x-request-id': 'req-first' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Final failure' }),
        headers: headers({}),
      });

    const api = new NansenAPI('test-key', undefined, {
      retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });
    await expect(api.smartMoneyNetflow({ chains: ['solana'] })).rejects.toMatchObject({
      details: { attempt: 2 },
    });
    expect(api.lastResponseMeta).toBeNull();
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
