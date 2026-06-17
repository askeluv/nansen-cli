import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../wallet.js', () => ({
  showWallet: vi.fn(),
  getWalletConfig: vi.fn(() => ({})),
  exportWallet: vi.fn(),
}));

import { showWallet } from '../wallet.js';
import { buildPerpCommands } from '../perp.js';

// These tests exercise client-side input validation only. Validation runs
// before any wallet resolution or network call, so a rejected input throws
// without needing a configured wallet.
const cmds = buildPerpCommands({ log: () => {} });

const baseOrder = {
  coin: 'ETH',
  side: 'buy',
  size: '0.01',
  price: '2000',
  type: 'limit',
  wallet: 'does-not-matter',
};

describe('perp order validation', () => {
  it('rejects a typo in --side instead of silently opening a short', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, side: 'xyz' }),
    ).rejects.toThrow(/Invalid --side "xyz"/);
  });

  it('rejects a near-miss synonym in --side', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, side: 'lng' }),
    ).rejects.toThrow(/Invalid --side/);
  });

  it('accepts long/short aliases', async () => {
    // These pass validation and fail later (no real wallet) — assert the
    // failure is NOT the side validation error.
    await expect(
      cmds.order([], null, {}, { ...baseOrder, side: 'long' }),
    ).rejects.not.toThrow(/Invalid --side/);
    await expect(
      cmds.order([], null, {}, { ...baseOrder, side: 'short' }),
    ).rejects.not.toThrow(/Invalid --side/);
  });

  it('rejects a negative --size', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, size: '-0.01' }),
    ).rejects.toThrow(/Invalid --size "-0.01"/);
  });

  it('rejects a non-numeric --size with a specific message (not the usage banner)', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, size: 'abc' }),
    ).rejects.toThrow(/Invalid --size "abc"/);
  });

  it('rejects a zero --price', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, price: '0' }),
    ).rejects.toThrow(/Invalid --price "0"/);
  });

  it('shows usage when a required arg is omitted', async () => {
    const { side, ...noSide } = baseOrder;
    void side;
    await expect(
      cmds.order([], null, {}, noSide),
    ).rejects.toThrow(/Usage: nansen perp order/);
  });
});

describe('perp close validation', () => {
  const baseClose = { coin: 'ETH', side: 'sell', size: '0.01', price: '2000', wallet: 'x' };

  it('only allows buy/sell for --side', async () => {
    await expect(
      cmds.close([], null, {}, { ...baseClose, side: 'long' }),
    ).rejects.toThrow(/Invalid --side "long"/);
  });

  it('rejects a negative --size', async () => {
    await expect(
      cmds.close([], null, {}, { ...baseClose, size: '-1' }),
    ).rejects.toThrow(/Invalid --size/);
  });
});

describe('perp leverage validation', () => {
  const baseLev = { coin: 'ETH', leverage: '3', wallet: 'x' };

  it('rejects a typo in --margin-type instead of silently switching to isolated', async () => {
    await expect(
      cmds.leverage([], null, {}, { ...baseLev, 'margin-type': 'xolated' }),
    ).rejects.toThrow(/Invalid --margin-type "xolated"/);
  });

  it('accepts cross/isolated', async () => {
    await expect(
      cmds.leverage([], null, {}, { ...baseLev, 'margin-type': 'isolated' }),
    ).rejects.not.toThrow(/Invalid --margin-type/);
  });

  it('rejects a zero --leverage with a specific message', async () => {
    await expect(
      cmds.leverage([], null, {}, { ...baseLev, leverage: '0' }),
    ).rejects.toThrow(/Invalid --leverage "0"/);
  });

  // meta exposes max_leverage per asset; the leverage command pre-checks against it.
  const metaApi = { request: async () => ({ assets: [{ name: 'ETH', max_leverage: 25, sz_decimals: 4, asset_id: 1 }] }) };

  it('rejects leverage above the asset maximum with a clear message', async () => {
    await expect(
      cmds.leverage([], metaApi, {}, { ...baseLev, leverage: '100' }),
    ).rejects.toThrow(/exceeds the 25x maximum for ETH/);
  });

  it('allows leverage within the asset maximum (passes the pre-check)', async () => {
    await expect(
      cmds.leverage([], metaApi, {}, { ...baseLev, leverage: '10' }),
    ).rejects.not.toThrow(/exceeds the/);
  });

  it('falls open when meta is unavailable (does not block on the pre-check)', async () => {
    const brokenApi = { request: async () => { throw new Error('meta down'); } };
    await expect(
      cmds.leverage([], brokenApi, {}, { ...baseLev, leverage: '100' }),
    ).rejects.not.toThrow(/exceeds the|meta down/);
  });
});

describe('perp cancel validation', () => {
  it('rejects --oid 0 with a specific message (not the usage banner)', async () => {
    await expect(
      cmds.cancel([], null, {}, { coin: 'ETH', oid: '0', wallet: 'x' }),
    ).rejects.toThrow(/Invalid --oid "0"/);
  });
});

describe('perp meta listing (L1)', () => {
  // 25 fake assets so the default-20 truncation is observable; HYPE is last.
  const assets = Array.from({ length: 25 }, (_, i) => ({
    asset_id: i,
    name: i === 24 ? 'HYPE' : `A${i}`,
    sz_decimals: 2,
    max_leverage: 50,
  }));
  const fakeApi = { request: async () => ({ assets }) };

  function run(options) {
    const logs = [];
    const metaCmds = buildPerpCommands({ log: (m) => logs.push(m) });
    return metaCmds.meta([], fakeApi, options.flags || {}, options.options || {}).then(() => logs.join('\n'));
  }

  it('truncates to 20 by default and hints at --all', async () => {
    const out = await run({});
    expect(out).toContain('... and 5 more');
    expect(out).not.toContain('HYPE');
  });

  it('shows everything with --all', async () => {
    const out = await run({ flags: { all: true } });
    expect(out).toContain('HYPE');
    expect(out).not.toContain('more (use --all');
  });

  it('filters by name with --filter', async () => {
    const out = await run({ options: { filter: 'hype' } });
    expect(out).toContain('HYPE');
    expect(out).toContain('matching "hype"');
  });
});

describe('perp wallet resolution (M5)', () => {
  beforeEach(() => {
    showWallet.mockReset();
  });

  it('rejects a wallet with no EVM address instead of querying for "undefined"', async () => {
    showWallet.mockReturnValue({ name: 'sol-only', solana: 'So111...', provider: 'local' });
    await expect(
      cmds.positions([], null, {}, { wallet: 'sol-only' }),
    ).rejects.toThrow(/no valid EVM address/);
  });

  it('rejects a malformed EVM address', async () => {
    showWallet.mockReturnValue({ name: 'bad', evm: '0xnothex', provider: 'local' });
    await expect(
      cmds.positions([], null, {}, { wallet: 'bad' }),
    ).rejects.toThrow(/no valid EVM address/);
  });
});
