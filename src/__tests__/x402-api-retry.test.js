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
 * Issue #583 — after a signed payment was transmitted, a non-ok response no
 * longer collapses everything (5xx, transport failures, unreadable bodies,
 * clean rejections) into a single `null`. Only a readable, legible rejection
 * body on a non-5xx status returns the X402_PAYMENT_REJECTED sentinel (safe
 * to try another payment option); anything else throws NansenError with code
 * PAYMENT_AMBIGUOUS, because the server may have already settled the payment
 * and trying another option would risk paying twice. The sentinel is also
 * distinct from a genuine successful response whose JSON body is `null`.
 *
 * These tests pin the contract so future changes to _x402Retry are caught
 * before they reach CI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NansenAPI, RESPONSE_META, X402_PAYMENT_REJECTED, ErrorCode, NansenError } from '../api.js';

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

  it('returns the X402_PAYMENT_REJECTED sentinel for a readable, non-5xx rejection', async () => {
    // Core contract: a rejection the server can prove (a legible, non-5xx
    // body) is safe to treat as "try the next payment option".
    mockFetch.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ error: 'payment rejected' }),
    });

    const api = makeApi();
    const result = await api._x402Retry(
      'test-sig', null, null, 'https://api.nansen.ai/test', {},
    );
    expect(result).toBe(X402_PAYMENT_REJECTED);
  });

  it('throws PAYMENT_AMBIGUOUS on a 5xx after the payment was transmitted (issue #583)', async () => {
    // A 5xx doesn't prove the payment was rejected — the server could have
    // settled it before failing to respond. Must not be treated the same as
    // a clean rejection, or the caller would sign and send another payment.
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'internal error' }),
    });

    const api = makeApi();
    await expect(
      api._x402Retry('test-sig', null, null, 'https://api.nansen.ai/test', {}),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_AMBIGUOUS });
  });

  it('throws PAYMENT_AMBIGUOUS when a non-5xx rejection body is unreadable (issue #583)', async () => {
    // A 4xx we can't even parse doesn't prove a clean rejection either.
    mockFetch.mockResolvedValue({
      ok: false,
      status: 402,
      json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON')),
    });

    const api = makeApi();
    await expect(
      api._x402Retry('test-sig', null, null, 'https://api.nansen.ai/test', {}),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_AMBIGUOUS });
  });

  it('throws PAYMENT_AMBIGUOUS when the fetch itself fails after transmission (issue #583)', async () => {
    // The signature was already on the wire when the connection dropped —
    // the server may have received and settled it.
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const api = makeApi();
    await expect(
      api._x402Retry('test-sig', null, null, 'https://api.nansen.ai/test', {}),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_AMBIGUOUS });
  });

  it('returns a genuine null success body as null, not the rejection sentinel (issue #583)', async () => {
    // A successful (ok) response whose JSON body happens to be `null` must
    // not be confused with a clean rejection — that would make the caller
    // sign and transmit a second payment for an already-settled request.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => null,
      headers: new Map(),
    });

    const api = makeApi();
    const result = await api._x402Retry(
      'test-sig', null, null, 'https://api.nansen.ai/test', {},
    );
    expect(result).toBeNull();
    expect(result).not.toBe(X402_PAYMENT_REJECTED);
  });

  it('returns the parsed JSON body with response metadata when the paid response is ok', async () => {
    // Regression for e918bdd: the resolved JSON value (not a Promise) is
    // returned so callers can use strict !== sentinel to detect success.
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
      credits: { used: null, remaining: 9, cost: null },
    });
    expect(api.lastResponseMeta).toEqual(result[RESPONSE_META]);
  });

  it('returns a falsy-but-valid JSON body as-is (regression for 3c25a0d)', async () => {
    // Before 3c25a0d the callers used `if (result)` — a valid response of
    // `false` would be misread as payment failure and the request would fall
    // through to the next payment option.  The fix uses `!== sentinel` instead.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => false,
    });

    const api = makeApi();
    const result = await api._x402Retry(
      'test-sig', null, null, 'https://api.nansen.ai/test', {},
    );
    // false is a valid (if unusual) API response — must not be treated as rejected
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
    expect(requestInit.method).toBe('POST');
    expect(requestInit.redirect).toBe('error');
    expect(requestInit.body).toBeDefined();
  });

  it('defaults to POST with a JSON body when options.method is omitted', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    const api = makeApi();
    await api._x402Retry(
      'sig', null, null, 'https://api.nansen.ai/test', { hello: 'world' },
    );

    const [, requestInit] = mockFetch.mock.calls[0];
    expect(requestInit.method).toBe('POST');
    expect(requestInit.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(requestInit.body)).toEqual({ hello: 'world' });
  });

  it('retries with GET and omits body when options.method is GET', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ account: true }) });

    const api = makeApi();
    await api._x402Retry(
      'sig', null, null, 'https://api.nansen.ai/api/v1/account', {}, { method: 'GET' },
    );

    const [, requestInit] = mockFetch.mock.calls[0];
    expect(requestInit.method).toBe('GET');
    expect(requestInit.body).toBeUndefined();
    expect(requestInit.headers['Content-Type']).toBeUndefined();
    expect(requestInit.headers['Payment-Signature']).toBe('sig');
  });

  it('retries with DELETE and omits body when options.method is DELETE', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ deleted: true }) });

    const api = makeApi();
    await api._x402Retry(
      'sig', null, null, 'https://api.nansen.ai/api/v1/smart-alert/1', { ignored: true }, { method: 'DELETE' },
    );

    const [, requestInit] = mockFetch.mock.calls[0];
    expect(requestInit.method).toBe('DELETE');
    expect(requestInit.body).toBeUndefined();
  });

  it('retries with PATCH and keeps a JSON body', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ patched: true }) });

    const api = makeApi();
    await api._x402Retry(
      'sig', null, null, 'https://api.nansen.ai/api/v1/smart-alert', { id: '1' }, { method: 'PATCH' },
    );

    const [, requestInit] = mockFetch.mock.calls[0];
    expect(requestInit.method).toBe('PATCH');
    expect(JSON.parse(requestInit.body)).toEqual({ id: '1' });
    expect(requestInit.headers['Content-Type']).toBe('application/json');
  });

  it('throws PAYMENT_AMBIGUOUS when an ok response body is not valid JSON (issue #583)', async () => {
    // Regression for e918bdd, updated for #583: the payment was accepted
    // (ok) — it settled — so a parse failure now surfaces as PAYMENT_AMBIGUOUS
    // rather than a bare SyntaxError, and must not be treated as a rejection
    // (that would risk paying again for an already-settled request).
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON')),
    });

    const api = makeApi();
    await expect(
      api._x402Retry('test-sig', null, null, 'https://api.nansen.ai/test', {}),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_AMBIGUOUS });
  });

  it('every PAYMENT_AMBIGUOUS error is a NansenError with an actionable message', async () => {
    mockFetch.mockRejectedValue(new TypeError('network down'));
    const api = makeApi();
    try {
      await api._x402Retry('test-sig', null, null, 'https://api.nansen.ai/test', {});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NansenError);
      expect(err.code).toBe(ErrorCode.PAYMENT_AMBIGUOUS);
      expect(err.message).toMatch(/not attempting another payment/i);
    }
  });
});
