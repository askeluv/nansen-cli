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
