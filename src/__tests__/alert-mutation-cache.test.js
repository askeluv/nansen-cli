import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let NansenAPI;
let originalHome;
let tempHome;

describe('Smart Alert mutation cache isolation', () => {
  beforeAll(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-alert-cache-test-'));
    process.env.HOME = tempHome;
    vi.resetModules();
    ({ NansenAPI } = await import('../api.js'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it.each([
    ['alertsCreate', [{ name: 'Cache create', type: 'sm-token-flows' }]],
    ['alertsUpdate', [{ id: 'cache-update', name: 'Updated' }]],
    ['alertsToggle', [{ id: 'cache-toggle', isEnabled: true }]],
    ['alertsDelete', ['cache-delete']],
  ])('%s bypasses the response cache', async (method, args) => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ success: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new NansenAPI('test-api-key', 'https://api.nansen.ai', {
      cache: { enabled: true, ttl: 300 },
    });
    await api[method](...args);
    await api[method](...args);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
