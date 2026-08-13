/**
 * `auth` and `doctor --offline` promise zero network activity. The help path
 * runs before command dispatch, so it has to honour the same contract — the
 * cost-map refresh fetches the OpenAPI spec and writes ~/.nansen/cost-map.json.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const refreshCostMapIfStale = vi.fn(async () => {});

vi.mock('../cost-cache.js', async (importOriginal) => ({
  ...(await importOriginal()),
  refreshCostMapIfStale,
}));

const { runCLI } = await import('../cli.js');

function baseDeps() {
  return { output: () => {}, errorOutput: () => {}, exit: () => {} };
}

describe('offline commands: --help does not touch the network', () => {
  let fetchSpy;

  beforeEach(() => {
    refreshCostMapIfStale.mockClear();
    fetchSpy = vi.fn(() => { throw new Error('network access in offline command'); });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('doctor --offline --help skips the cost-map refresh', async () => {
    await runCLI(['doctor', '--offline', '--help'], baseDeps());
    expect(refreshCostMapIfStale).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('auth --help skips the cost-map refresh', async () => {
    await runCLI(['auth', '--help'], baseDeps());
    expect(refreshCostMapIfStale).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('auth status --help skips the cost-map refresh', async () => {
    await runCLI(['auth', 'status', '--help'], baseDeps());
    expect(refreshCostMapIfStale).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('doctor --help (online) still refreshes the cost map', async () => {
    await runCLI(['doctor', '--help'], baseDeps());
    expect(refreshCostMapIfStale).toHaveBeenCalledOnce();
  });

  it('top-level help still refreshes the cost map', async () => {
    await runCLI(['help'], baseDeps());
    expect(refreshCostMapIfStale).toHaveBeenCalledOnce();
  });
});
