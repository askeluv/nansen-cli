/**
 * Verify that every first-level CLI command triggers telemetry tracking.
 *
 * For each command we invoke runCLI() with minimal args (enough for the
 * command to execute) and assert that trackCommandSucceeded or
 * trackCommandFailed was called exactly once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock telemetry before cli.js is imported ──
const trackSucceeded = vi.fn();
const trackFailed = vi.fn();

vi.mock('../telemetry.js', () => ({
  trackCommandSucceeded: trackSucceeded,
  trackCommandFailed: trackFailed,
  getAnonymousId: () => 'test-anon-id',
  getSessionId: () => 'test-session-id',
}));

const { runCLI, buildCommands } = await import('../cli.js');
const { buildWalletCommands } = await import('../wallet.js');
const { buildTradingCommands } = await import('../trading.js');

// ── Helpers ──

/** Minimal deps that swallow output and prevent process.exit. */
function baseDeps(overrides = {}) {
  return {
    output: () => {},
    errorOutput: () => {},
    exit: () => {},
    ...overrides,
  };
}

/** A mock NansenAPI constructor whose every method resolves to stub data. */
function MockAPI() {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (typeof prop === 'string' && prop !== 'then') {
        return vi.fn().mockResolvedValue({ data: [] });
      }
    },
  });
}

function depsWithApi(overrides = {}) {
  return baseDeps({ NansenAPIClass: MockAPI, ...overrides });
}

function wasTracked() {
  return trackSucceeded.mock.calls.length + trackFailed.mock.calls.length;
}

describe('telemetry tracking for all first-level commands', () => {
  beforeEach(() => {
    trackSucceeded.mockClear();
    trackFailed.mockClear();
  });

  // ── Research sub-categories (each is also a top-level deprecated alias) ──
  const researchCategories = [
    { category: 'smart-money', sub: 'netflow' },
    { category: 'profiler',    sub: 'labels', extraOpts: ['--address', '0x1234'] },
    { category: 'token',       sub: 'screener' },
    { category: 'search',      sub: 'search', extraOpts: ['--query', 'bitcoin'] },
    { category: 'perp',        sub: 'screener' },
    { category: 'portfolio',   sub: 'current', extraOpts: ['--address', '0x1234'] },
    { category: 'points',      sub: 'leaderboard' },
    { category: 'prediction-market', sub: 'market-screener' },
  ];

  for (const { category, sub, extraOpts = [] } of researchCategories) {
    it(`research ${category} ${sub}`, async () => {
      await runCLI(['research', category, sub, ...extraOpts], depsWithApi());
      expect(wasTracked()).toBe(1);
      expect(trackSucceeded).toHaveBeenCalledOnce();
      // fullCommand = "research <category>" (subcommand is the category within research)
      expect(trackSucceeded.mock.calls[0][0].command).toBe(`research ${category}`);
    });

    // The deprecated top-level alias should also track
    it(`${category} ${sub} (deprecated alias)`, async () => {
      await runCLI([category, sub, ...extraOpts], depsWithApi());
      expect(wasTracked()).toBe(1);
      expect(trackSucceeded).toHaveBeenCalledOnce();
    });
  }

  // ── Operational commands ──

  it('account', async () => {
    await runCLI(['account'], depsWithApi());
    expect(wasTracked()).toBe(1);
    expect(trackSucceeded).toHaveBeenCalledOnce();
    expect(trackSucceeded.mock.calls[0][0].command).toBe('account');
  });

  it('web search', async () => {
    await runCLI(['web', 'search', '--query', 'bitcoin price'], depsWithApi());
    expect(wasTracked()).toBe(1);
    expect(trackSucceeded).toHaveBeenCalledOnce();
    expect(trackSucceeded.mock.calls[0][0].command).toBe('web search');
  });

  it('web fetch', async () => {
    await runCLI(['web', 'fetch', '--url', 'https://example.com', '--question', 'What is this?'], depsWithApi());
    expect(wasTracked()).toBe(1);
    expect(trackSucceeded).toHaveBeenCalledOnce();
    expect(trackSucceeded.mock.calls[0][0].command).toBe('web fetch');
  });

  it('login (with --api-key)', async () => {
    const err = Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' });
    function FailingAPI() {
      return { getAccount: vi.fn().mockRejectedValue(err) };
    }
    await runCLI(['login', '--api-key', 'test-key'], baseDeps({
      NansenAPIClass: FailingAPI,
      saveConfigFn: () => {},
      getConfigFileFn: () => '/tmp/fake-config.json',
    }));
    expect(wasTracked()).toBe(1);
    expect(trackFailed).toHaveBeenCalledOnce();
    expect(trackFailed.mock.calls[0][0].command).toBe('login');
  });

  it('logout', async () => {
    await runCLI(['logout'], baseDeps({
      deleteConfigFn: () => true,
      getConfigFileFn: () => '/tmp/fake-config.json',
    }));
    expect(wasTracked()).toBe(1);
    expect(trackSucceeded).toHaveBeenCalledOnce();
    expect(trackSucceeded.mock.calls[0][0].command).toBe('logout');
  });

  it('schema', async () => {
    await runCLI(['schema'], baseDeps());
    expect(wasTracked()).toBe(1);
    expect(trackSucceeded).toHaveBeenCalledOnce();
    expect(trackSucceeded.mock.calls[0][0].command).toBe('schema');
  });

  it('cache clear', async () => {
    await runCLI(['cache', 'clear'], baseDeps());
    expect(wasTracked()).toBe(1);
    expect(trackSucceeded).toHaveBeenCalledOnce();
    expect(trackSucceeded.mock.calls[0][0].command).toBe('cache clear');
  });

  it('changelog', async () => {
    await runCLI(['changelog'], baseDeps());
    expect(wasTracked()).toBe(1);
    expect(trackSucceeded).toHaveBeenCalledOnce();
    expect(trackSucceeded.mock.calls[0][0].command).toBe('changelog');
  });

  it('wallet (help subcommand)', async () => {
    await runCLI(['wallet'], baseDeps());
    expect(wasTracked()).toBe(1);
    expect(trackSucceeded).toHaveBeenCalledOnce();
    expect(trackSucceeded.mock.calls[0][0].command).toBe('wallet');
  });

  it('trade quote (missing args shows usage)', async () => {
    await runCLI(['trade', 'quote'], baseDeps());
    expect(wasTracked()).toBe(1);
    expect(trackFailed).toHaveBeenCalledOnce();
    expect(trackFailed.mock.calls[0][0].command).toBe('trade quote');
  });

  // ── Error path ──

  it('unknown command triggers trackCommandFailed', async () => {
    await runCLI(['nonexistent-command-xyz'], baseDeps());
    expect(wasTracked()).toBe(1);
    expect(trackFailed).toHaveBeenCalledOnce();
    expect(trackFailed.mock.calls[0][0].error_code).toBe('UNKNOWN_COMMAND');
  });

  it('API error triggers trackCommandFailed', async () => {
    const err = new Error('Unauthorized');
    err.code = 'UNAUTHORIZED';
    err.status = 401;
    const deps = baseDeps({
      NansenAPIClass: function FailAPI() {
        return new Proxy({}, {
          get: (_target, prop) => {
            if (typeof prop === 'string' && prop !== 'then') {
              return vi.fn().mockRejectedValue(err);
            }
          },
        });
      },
    });
    await runCLI(['smart-money', 'netflow'], deps);
    expect(wasTracked()).toBe(1);
    expect(trackFailed).toHaveBeenCalledOnce();
    expect(trackFailed.mock.calls[0][0].error_code).toBe('UNAUTHORIZED');
    expect(trackFailed.mock.calls[0][0].status).toBe(401);
  });

  // ── Meta commands should NOT trigger telemetry ──

  it('--help does not trigger telemetry', async () => {
    await runCLI(['--help'], baseDeps());
    expect(wasTracked()).toBe(0);
  });

  it('--version does not trigger telemetry', async () => {
    await runCLI(['--version'], baseDeps());
    expect(wasTracked()).toBe(0);
  });

  // ── Guard: every registered command must be tested above ──

  it('all registered commands have telemetry tests', () => {
    const allCommands = {
      ...buildCommands(),
      ...buildWalletCommands(),
      ...buildTradingCommands(),
    };
    const registeredCommands = new Set(Object.keys(allCommands));

    // Commands explicitly tested above (must stay in sync)
    const testedCommands = new Set([
      // research sub-categories (tested via both `research <cat>` and deprecated alias)
      'smart-money', 'profiler', 'token', 'search', 'perp', 'portfolio', 'points', 'prediction-market',
      'research',
      // operational
      'account', 'login', 'logout', 'schema', 'cache', 'changelog',
      'web',
      // wallet & trading
      'wallet', 'trade', 'quote', 'execute', 'bridge-status',
      // help is a meta command, intentionally not tracked
      'help',
    ]);

    const untested = [...registeredCommands].filter(cmd => !testedCommands.has(cmd));
    expect(untested, `Untested commands need telemetry tracking tests: ${untested.join(', ')}`).toEqual([]);
  });
});
