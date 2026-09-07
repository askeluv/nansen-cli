/**
 * The `from_cache` telemetry field has to reflect reality.
 *
 * `getCachedResponse()` records the cache hit under `_meta`, so reading a bare
 * `result.fromCache` at the tracking call site always found `undefined` and
 * every command reported a cache miss — including the ones served from cache.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const trackSucceeded = vi.fn();
const trackFailed = vi.fn();

vi.mock('../telemetry.js', async (importOriginal) => ({
  ...(await importOriginal()),
  trackCommandSucceeded: trackSucceeded,
  trackCommandFailed: trackFailed,
  trackPerpOrderCompleted: vi.fn(),
  getAnonymousId: () => 'test-anon-id',
  getSessionId: () => 'test-session-id',
}));

let tempHome;
let prevHome;
let prevUserProfile;
let prevApiKey;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-from-cache-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevApiKey = process.env.NANSEN_API_KEY;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.NANSEN_API_KEY = 'test-key';
  trackSucceeded.mockClear();
  trackFailed.mockClear();
});

afterEach(() => {
  const restore = (name, value) => {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  };
  restore('HOME', prevHome);
  restore('USERPROFILE', prevUserProfile);
  restore('NANSEN_API_KEY', prevApiKey);
  fs.rmSync(tempHome, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Load cli.js and the real NansenAPI against a mocked network. */
async function loadCli(payload) {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => JSON.parse(JSON.stringify(payload)),
  })));
  const { runCLI } = await import('../cli.js');
  const { NansenAPI } = await import('../api.js');
  return { runCLI, NansenAPI };
}

describe('from_cache telemetry', () => {
  it('reports the cache hit on the second identical --cache call', async () => {
    const { runCLI, NansenAPI } = await loadCli({ data: [{ symbol: 'ETH' }] });
    const deps = {
      output: () => {},
      errorOutput: () => {},
      exit: () => {},
      NansenAPIClass: NansenAPI,
    };
    const argv = ['research', 'token', 'screener', '--cache'];

    await runCLI(argv, deps);
    await runCLI(argv, deps);

    expect(trackSucceeded).toHaveBeenCalledTimes(2);
    const [first, second] = trackSucceeded.mock.calls.map(c => c[0]);
    expect(first.from_cache).toBe(false);
    // Served from the local cache — the network was only hit once.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second.from_cache).toBe(true);
  });

  it('reports the cache hit on the --stream output path', async () => {
    const { runCLI, NansenAPI } = await loadCli({ data: [{ symbol: 'ETH' }] });
    const deps = { output: () => {}, errorOutput: () => {}, exit: () => {}, NansenAPIClass: NansenAPI };
    const argv = ['research', 'token', 'screener', '--cache', '--stream'];

    await runCLI(argv, deps);
    await runCLI(argv, deps);

    const [first, second] = trackSucceeded.mock.calls.map(c => c[0]);
    expect(first.from_cache).toBe(false);
    expect(second.from_cache).toBe(true);
  });

  it('reports the cache hit on the alerts list --table path', async () => {
    const { runCLI, NansenAPI } = await loadCli([{ id: 'a1', name: 'whale moves' }]);
    const deps = { output: () => {}, errorOutput: () => {}, exit: () => {}, NansenAPIClass: NansenAPI };
    const argv = ['alerts', 'list', '--table', '--cache'];

    await runCLI(argv, deps);
    await runCLI(argv, deps);

    const [first, second] = trackSucceeded.mock.calls.map(c => c[0]);
    // This path previously never passed the field at all, so it defaulted to false.
    expect(first.from_cache).toBe(false);
    expect(second.from_cache).toBe(true);
  });
});
