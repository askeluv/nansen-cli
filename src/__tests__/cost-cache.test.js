/**
 * creditsCharged — authoritative header cost vs spec-derived estimate.
 *
 * cost-cache.js resolves ~/.nansen at import time, so each test re-imports the
 * module with HOME pointed at a fresh temp dir (same pattern as keychain.test.js).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

describe('creditsCharged', () => {
  let tempDir;
  let originalEnv;
  let creditsCharged;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-cost-cache-test-'));
    process.env.HOME = tempDir;
    vi.resetModules();
    ({ creditsCharged } = await import('../cost-cache.js'));
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedCache(costs) {
    const dir = path.join(tempDir, '.nansen');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cost-map.json'), JSON.stringify({ costs, fetchedAt: Date.now() }));
  }

  it('prefers the header cost over any estimate', () => {
    seedCache({ '/api/v1/foo': { free: 3, pro: 5 } });
    const result = creditsCharged({ credits: { used: 5, remaining: 100, cost: 7 } }, '/api/v1/foo');
    expect(result).toEqual({ cost: 7, source: 'header' });
  });

  it('falls back to the spec estimate when the cost header is absent', () => {
    seedCache({ '/api/v1/foo': { free: 3, pro: 5 } });
    const result = creditsCharged({ credits: { used: 5, remaining: 100, cost: null } }, '/api/v1/foo');
    expect(result).toEqual({ estimate: { free: 3, pro: 5 }, source: 'estimate' });
  });

  it('treats a zero charge as a value, not as absent', () => {
    seedCache({ '/api/v1/foo': { free: 3, pro: 5 } });
    const result = creditsCharged({ credits: { used: null, remaining: 100, cost: 0 } }, '/api/v1/foo');
    expect(result).toEqual({ cost: 0, source: 'header' });
  });

  it('falls back to the spec estimate when no headers arrived', () => {
    seedCache({ '/api/v1/foo': { free: 3, pro: 5 } });
    const result = creditsCharged(null, '/api/v1/foo');
    expect(result).toEqual({ estimate: { free: 3, pro: 5 }, source: 'estimate' });
  });

  it('returns null when neither headers nor an estimate exist', () => {
    expect(creditsCharged(null, '/api/v1/unknown')).toBeNull();
    expect(creditsCharged(null, null)).toBeNull();
    expect(creditsCharged({ credits: { used: 5, cost: null } }, '/api/v1/unknown')).toBeNull();
    expect(creditsCharged({ rateLimit: { limit: 1, remaining: 1, resetSeconds: 1 } }, null)).toBeNull();
  });
});

describe('refreshCostMapIfStale', () => {
  let tempDir;
  let originalEnv;
  let refreshCostMapIfStale;
  let getCostForEndpoint;

  const spec = {
    paths: {
      '/api/v1/foo': { get: { 'x-credit-cost': { free: 3, pro: 5 } } },
    },
  };

  beforeEach(async () => {
    originalEnv = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-cost-refresh-test-'));
    process.env.HOME = tempDir;
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => spec })));
    ({ refreshCostMapIfStale, getCostForEndpoint } = await import('../cost-cache.js'));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const cacheDir = () => path.join(tempDir, '.nansen');
  const cacheFile = () => path.join(cacheDir(), 'cost-map.json');

  it('writes a valid, parseable cost map on a cold cache', async () => {
    await refreshCostMapIfStale();
    const parsed = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    expect(parsed.costs).toEqual({ '/api/v1/foo': { free: 3, pro: 5 } });
    expect(typeof parsed.fetchedAt).toBe('number');
    expect(getCostForEndpoint('/api/v1/foo')).toEqual({ free: 3, pro: 5 });
  });

  it('writes atomically via rename, leaving no temp file behind', async () => {
    const renameSpy = vi.spyOn(fs, 'renameSync');
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    await refreshCostMapIfStale();

    // The payload is written to a temp path, then renamed onto the target —
    // the target is never passed to writeFileSync directly.
    expect(renameSpy).toHaveBeenCalledWith(expect.stringContaining('.tmp'), cacheFile());
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('.tmp'), expect.any(String));
    expect(writeSpy).not.toHaveBeenCalledWith(cacheFile(), expect.anything());

    // No temp files linger in the config dir.
    const leftovers = fs.readdirSync(cacheDir()).filter(f => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
    renameSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('cleans up the temp file when the rename fails', async () => {
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename boom');
    });
    // Error is swallowed by refreshCostMapIfStale's catch.
    await refreshCostMapIfStale();
    const leftovers = fs.readdirSync(cacheDir()).filter(f => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
    expect(fs.existsSync(cacheFile())).toBe(false);
    renameSpy.mockRestore();
  });

  it('skips the fetch and write when the cache is fresh', async () => {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify({ costs: {}, fetchedAt: Date.now() }));
    await refreshCostMapIfStale();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes when the cache is stale', async () => {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const stale = Date.now() - 25 * 60 * 60 * 1000;
    fs.writeFileSync(cacheFile(), JSON.stringify({ costs: {}, fetchedAt: stale }));
    await refreshCostMapIfStale();
    expect(fetch).toHaveBeenCalledOnce();
    expect(getCostForEndpoint('/api/v1/foo')).toEqual({ free: 3, pro: 5 });
  });
});
