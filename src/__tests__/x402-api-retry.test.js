/**
 * Regression tests for NansenAPI._x402Retry
 *
 * PR #264 extracted _x402Retry from three duplicated call sites but landed
 * without tests. Two bugs were fixed within the same PR via pre-merge commits:
 *
 *   3c25a0d — null check was truthy (`if (result)`): a valid API response of
 *     `false` or `0` would wrongly be treated as payment failure, causing the
 *     caller to try additional payment methods and ultimately throw.
 *
 *   e918bdd — missing await on paidResponse.json(): the rejection from a
 *     non-JSON body may not propagate cleanly through all runtime environments
 *     without an explicit await in the async function body.
 *
 * These tests pin the contract so future changes to _x402Retry are caught
 * before they reach CI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NansenAPI, RESPONSE_META } from '../api.js';

function makeApi() {
  return new NansenAPI('test-key', 'https://api.nansen.ai');
}

describe('NansenAPI._x402Retry', () => {
  let mockFetch;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when the paid response is not ok', async () => {
    // Core contract: a rejected payment (non-ok retry) yields null so the
    // caller can fall through to the next payment option.
    mockFetch.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ error: 'payment rejected' }),
    });

    const api = makeApi();
    const result = await api._x402Retry(
      'test-sig', null, null, 'https://api.nansen.ai/test', {},
    );
    expect(result).toBeNull();
  });

  it('returns the parsed JSON body with response metadata when the paid response is ok', async () => {
    // Regression for e918bdd: the resolved JSON value (not a Promise) is
    // returned so callers can use strict !== null to detect success.
    const responseData = { data: { token: 'ETH', value: 1234 } };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => responseData,
      headers: new Map([
        ['x-request-id', 'req-paid'],
        ['x-nansen-credits-remaining', '9'],
      ]),
    });

    const api = makeApi();
    const result = await api._x402Retry(
      'test-sig', null, null, 'https://api.nansen.ai/test', {},
    );
    expect(result).toBe(responseData);
    expect(result[RESPONSE_META]).toEqual({
      requestId: 'req-paid',
      credits: { used: null, remaining: 9 },
    });
    expect(api.lastResponseMeta).toEqual(result[RESPONSE_META]);
  });

  it('returns a falsy-but-valid JSON body as-is (regression for 3c25a0d)', async () => {
    // Before 3c25a0d the callers used `if (result)` — a valid response of
    // `false` would be misread as payment failure and the request would fall
    // through to the next payment option.  The fix uses `!== null` instead.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => false,
    });

    const api = makeApi();
    const result = await api._x402Retry(
      'test-sig', null, null, 'https://api.nansen.ai/test', {},
    );
    // false is a valid (if unusual) API response — must not be treated as null
    expect(result).toBe(false);
  });

  it('sends the Payment-Signature header in the retry request', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

    const api = makeApi();
    await api._x402Retry(
      'my-payment-sig', null, null, 'https://api.nansen.ai/test', {},
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, requestInit] = mockFetch.mock.calls[0];
    expect(requestInit.headers['Payment-Signature']).toBe('my-payment-sig');
  });

  it('propagates json() rejection when the paid response body is not valid JSON', async () => {
    // Regression for e918bdd: the explicit await ensures a parsing failure
    // surfaces as a clean rejection from _x402Retry rather than being lost.
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON')),
    });

    const api = makeApi();
    await expect(
      api._x402Retry('test-sig', null, null, 'https://api.nansen.ai/test', {}),
    ).rejects.toThrow('Unexpected token');
  });
});
