/**
 * Response cache tests — `nansen --cache`.
 *
 * The cache has to hand back exactly what the network handed back. A cached
 * response that changes shape is worse than no cache at all: the first call
 * renders and the second one silently does not.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let tempHome;
let prevHome;
let prevUserProfile;

/**
 * api.js resolves the cache directory from HOME at import time, so the temp
 * home has to be in place before the module is loaded.
 */
async function freshApi(payload, options = {}) {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => JSON.parse(JSON.stringify(payload)),
  })));
  const { NansenAPI } = await import('../api.js');
  return new NansenAPI('test-key', 'https://api.nansen.ai', {
    cache: { enabled: true, ttl: 300 },
    ...options,
  });
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-api-cache-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(tempHome, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('response cache preserves the payload shape', () => {
  it('returns a top-level array as an array on a cache hit', async () => {
    const rows = [{ symbol: 'ETH', volume: 1 }, { symbol: 'SOL', volume: 2 }];
    const api = await freshApi(rows);

    const live = await api.request('/api/v1/demo', { chain: 'ethereum' });
    const cached = await api.request('/api/v1/demo', { chain: 'ethereum' });

    expect(Array.isArray(live)).toBe(true);
    // Object-spreading the cached array used to yield { 0: …, 1: … }, which
    // every Array.isArray() branch in the output formatters then skipped.
    expect(Array.isArray(cached)).toBe(true);
    expect(cached).toHaveLength(2);
    expect([...cached]).toEqual(rows);
    expect(cached._meta.fromCache).toBe(true);
    expect(cached._meta.cacheAge).toBeTypeOf('number');
  });

  it('serves the cache on the second call rather than refetching', async () => {
    const api = await freshApi([{ symbol: 'ETH' }]);

    await api.request('/api/v1/demo', {});
    await api.request('/api/v1/demo', {});

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('still merges _meta into an object response', async () => {
    const body = { data: [{ symbol: 'ETH' }], total: 1 };
    const api = await freshApi(body);

    await api.request('/api/v1/demo', {});
    const cached = await api.request('/api/v1/demo', {});

    expect(Array.isArray(cached)).toBe(false);
    expect(cached.data).toEqual(body.data);
    expect(cached.total).toBe(1);
    expect(cached._meta.fromCache).toBe(true);
  });

  it('hands back a primitive response untouched', async () => {
    const api = await freshApi('plain-text-body');

    await api.request('/api/v1/demo', {});
    const cached = await api.request('/api/v1/demo', {});

    // A string cannot carry the marker; spreading one used to explode it into
    // { 0: 'p', 1: 'l', … }.
    expect(cached).toBe('plain-text-body');
  });
});
