import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../wallet.js', () => ({
  showWallet: vi.fn(),
  getWalletConfig: vi.fn(() => ({})),
  exportWallet: vi.fn(),
}));

vi.mock('../keychain.js', () => ({
  retrievePassword: vi.fn(() => ({ password: null, source: null })),
}));

// Stub the ONE direct-to-HL network call so the flow tests can assert what
// gets submitted without hitting api.hyperliquid.xyz. No existing test reaches
// submit (they throw at validation/wallet/screening first), so this is inert
// for them.
vi.mock('../hl-client.js', () => ({
  submitExchange: vi.fn(async () => ({ status: 'ok', response: { data: { statuses: [{ resting: {} }] } } })),
}));

import { showWallet, getWalletConfig, exportWallet } from '../wallet.js';
import { submitExchange } from '../hl-client.js';
import { buildPerpCommands, effectiveOrderValues } from '../perp.js';

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

  it('rejects --size with trailing garbage instead of parseFloat-ing it to a number', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, size: '100abc' }),
    ).rejects.toThrow(/Invalid --size "100abc"/);
  });

  it('rejects an unknown --tif client-side', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, tif: 'InvalidTIF' }),
    ).rejects.toThrow(/Invalid --tif "InvalidTIF"/);
  });

  it('rejects an unknown --type client-side', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, type: 'stop' }),
    ).rejects.toThrow(/Invalid --type "stop"/);
  });

  it('accepts a case-insensitive --type (LIMIT) and valid --tif', async () => {
    // Pass validation and fail later (no real wallet) — assert the failure is
    // NOT a type/tif validation error.
    await expect(
      cmds.order([], null, {}, { ...baseOrder, type: 'LIMIT', tif: 'Ioc' }),
    ).rejects.not.toThrow(/Invalid --(type|tif)/);
  });

  it('rejects --slippage with trailing garbage', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, slippage: '0.03abc' }),
    ).rejects.toThrow(/Invalid --slippage "0.03abc"/);
  });

  it('rejects an out-of-range --slippage (percent-vs-decimal mix-up)', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, slippage: '3' }),
    ).rejects.toThrow(/Invalid --slippage "3"/);
  });

  it('rejects a non-numeric --take-profit', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, 'take-profit': '1800x' }),
    ).rejects.toThrow(/Invalid --take-profit "1800x"/);
  });

  it('rejects a negative --stop-loss', async () => {
    await expect(
      cmds.order([], null, {}, { ...baseOrder, 'stop-loss': '-1' }),
    ).rejects.toThrow(/Invalid --stop-loss "-1"/);
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

describe('perp precision warnings (NEW — price/size precision)', () => {
  // BTC with szDecimals=4 → max 4 size decimals, max (6-4)=2 price decimals.
  const metaApi = { request: async () => ({ assets: [{ name: 'BTC', sz_decimals: 4, max_leverage: 50, asset_id: 1 }] }) };
  const base = { coin: 'BTC', side: 'buy', size: '0.001', price: '50000', type: 'limit' };

  function runOrder(options) {
    const warnings = [];
    const cmds2 = buildPerpCommands({ log: () => {}, warn: (m) => warnings.push(m) });
    // Validation/warnings run before wallet resolution, which then rejects (no
    // wallet) — swallow that so we can assert on the warnings collected first.
    return cmds2.order([], metaApi, {}, options).catch(() => warnings);
  }

  it('warns when --size is finer than the asset allows (M4 root cause)', async () => {
    const warnings = await runOrder({ ...base, size: '0.0071111' });
    expect(warnings.some(w => /--size 0.0071111 is more precise than BTC/.test(w))).toBe(true);
  });

  it('warns when --price exceeds the asset price precision (NEW)', async () => {
    const warnings = await runOrder({ ...base, price: '50000.123' });
    expect(warnings.some(w => /--price 50000.123 is more precise than BTC/.test(w))).toBe(true);
  });

  it('does not warn when size and price are within precision', async () => {
    const warnings = await runOrder({ ...base, size: '0.0071', price: '50000.1' });
    expect(warnings.length).toBe(0);
  });

  it('falls open (no warning, no crash) when meta is unavailable', async () => {
    const warnings = [];
    const brokenApi = { request: async () => { throw new Error('meta down'); } };
    const cmds2 = buildPerpCommands({ log: () => {}, warn: (m) => warnings.push(m) });
    await cmds2.order([], brokenApi, {}, { ...base, size: '0.0071111' }).catch(() => {});
    expect(warnings.length).toBe(0);
  });
});

describe('perp effective order values (M4 display)', () => {
  it('prefers the backend-rounded size/price over raw input', () => {
    const prepared = {
      size: 0.0071,
      price: 50000,
      action: { orders: [{ s: '0.0071', p: '50000' }] },
    };
    expect(effectiveOrderValues(prepared)).toEqual({ size: 0.0071, price: 50000 });
  });

  it('falls back to the signed order wire (s/p) when size/price are absent', () => {
    const prepared = { action: { orders: [{ s: '0.0071', p: '50000' }] } };
    expect(effectiveOrderValues(prepared)).toEqual({ size: 0.0071, price: 50000 });
  });

  it('returns undefined for an action with no order (cancel/leverage/transfer)', () => {
    expect(effectiveOrderValues({ action: { type: 'cancel', cancels: [] } })).toEqual({
      size: undefined,
      price: undefined,
    });
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

  it('rejects an out-of-range --slippage', async () => {
    await expect(
      cmds.close([], null, {}, { ...baseClose, slippage: '5' }),
    ).rejects.toThrow(/Invalid --slippage "5"/);
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

  it('rejects a fractional --leverage instead of silently flooring it', async () => {
    await expect(
      cmds.leverage([], null, {}, { ...baseLev, leverage: '2.5' }),
    ).rejects.toThrow(/Invalid --leverage "2.5"/);
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

describe('perp close direction (NEW-4)', () => {
  const baseClose = { coin: 'ETH', size: '0.1', price: '2000', wallet: 'x' };
  const apiWith = (positions) => ({ request: vi.fn(async () => ({ positions })) });

  beforeEach(() => {
    showWallet.mockReturnValue({ name: 'x', evm: '0x' + '1'.repeat(40), provider: 'local' });
  });

  it('rejects closing a long with --side buy (wrong direction)', async () => {
    const api = apiWith([{ coin: 'ETH', szi: '0.5' }]);
    await expect(
      cmds.close([], api, {}, { ...baseClose, side: 'buy' }),
    ).rejects.toThrow(/Cannot close a long ETH position with --side buy\. Use --side sell/);
  });

  it('rejects closing a short with --side sell (wrong direction)', async () => {
    const api = apiWith([{ coin: 'ETH', szi: '-0.5' }]);
    await expect(
      cmds.close([], api, {}, { ...baseClose, side: 'sell' }),
    ).rejects.toThrow(/Cannot close a short ETH position with --side sell\. Use --side buy/);
  });

  it('allows the correct close direction (sell closes a long)', async () => {
    const api = apiWith([{ coin: 'ETH', szi: '0.5' }]);
    await expect(
      cmds.close([], api, {}, { ...baseClose, side: 'sell' }),
    ).rejects.not.toThrow(/Cannot close/);
  });

  it('falls open when no open position matches the coin', async () => {
    const api = apiWith([{ coin: 'BTC', szi: '0.5' }]);
    await expect(
      cmds.close([], api, {}, { ...baseClose, side: 'buy' }),
    ).rejects.not.toThrow(/Cannot close/);
  });

  it('falls open when the positions lookup fails', async () => {
    const brokenApi = { request: vi.fn(async () => { throw new Error('positions down'); }) };
    await expect(
      cmds.close([], brokenApi, {}, { ...baseClose, side: 'buy' }),
    ).rejects.not.toThrow(/Cannot close|positions down/);
  });
});

describe('perp duplicate flags (6824)', () => {
  it('rejects a duplicated --coin with a clean coded error instead of crashing', async () => {
    const err = await cmds.order([], null, {}, { ...baseOrder, coin: ['ETH', 'BTC'] }).catch(e => e);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toMatch(/--coin was provided more than once/);
    expect(err.message).not.toMatch(/is not a function/);
  });

  it('rejects a duplicated --side instead of crashing', async () => {
    const err = await cmds.order([], null, {}, { ...baseOrder, side: ['buy', 'sell'] }).catch(e => e);
    expect(err.message).toMatch(/--side was provided more than once/);
    expect(err.message).not.toMatch(/is not a function/);
  });

  it('rejects a duplicated --size instead of silently using the first value', async () => {
    const err = await cmds.order([], null, {}, { ...baseOrder, size: ['0.1', '0.2'] }).catch(e => e);
    expect(err.message).toMatch(/--size was provided more than once/);
  });

  it('rejects a duplicated --oid', async () => {
    const err = await cmds.cancel([], null, {}, { coin: 'ETH', oid: ['111', '222'], wallet: 'x' }).catch(e => e);
    expect(err.message).toMatch(/--oid was provided more than once/);
  });
});

describe('perp coded errors (6826 N2)', () => {
  it('throws a coded INVALID_INPUT error (not a bare Error) so agents can branch', async () => {
    const err = await cmds.order([], null, {}, { ...baseOrder, side: 'xyz' }).catch(e => e);
    expect(err.name).toBe('CommandError');
    expect(err.code).toBe('INVALID_INPUT');
  });
});

describe('perp --symbol alias (6827)', () => {
  it('accepts --symbol as an alias for --coin (no usage banner)', async () => {
    const { coin, ...noCoin } = baseOrder;
    void coin;
    // passes coin resolution; fails later (no real wallet) — assert it is NOT
    // the usage banner that a missing --coin would produce.
    await expect(
      cmds.order([], null, {}, { ...noCoin, symbol: 'ETH' }),
    ).rejects.not.toThrow(/Usage: nansen perp order/);
  });
});

describe('perp password (6826 N4)', () => {
  beforeEach(() => {
    showWallet.mockReturnValue({ name: 'x', evm: '0x' + '1'.repeat(40), provider: 'local' });
    getWalletConfig.mockReturnValue({ passwordHash: 'hash', defaultWallet: 'x' });
  });
  afterEach(() => {
    getWalletConfig.mockReturnValue({});
  });

  it('reports PASSWORD_REQUIRED (not "Incorrect password") when none is configured', async () => {
    const err = await cmds.order([], null, {}, { ...baseOrder, wallet: 'x' }).catch(e => e);
    expect(err.code).toBe('PASSWORD_REQUIRED');
    expect(err.message).not.toMatch(/Incorrect password/);
    expect(err.data?.resolution?.length).toBeGreaterThan(0);
  });
});

describe('perp account PnL (6828)', () => {
  beforeEach(() => {
    showWallet.mockReturnValue({ name: 'x', evm: '0x' + '1'.repeat(40), provider: 'local' });
  });

  it('shows real unrealized PnL summed from positions, not the account value', async () => {
    const logs = [];
    const accountCmds = buildPerpCommands({ log: (m) => logs.push(m) });
    const api = {
      request: vi.fn(async () => ({
        marginSummary: { accountValue: '14.98945', totalRawUsd: '14.98945', totalMarginUsed: '0.0' },
        withdrawable: '14.98945',
        assetPositions: [{ position: { coin: 'ETH', unrealizedPnl: '-0.01' } }],
      })),
    };
    await accountCmds.account([], api, {}, { wallet: 'x' });
    const out = logs.join('\n');
    expect(out).toContain('Unrealized PnL:  $-0.01');
    expect(out).not.toContain('Total PnL');
  });

  it('surfaces the Spot USDC balance (API-14)', async () => {
    const logs = [];
    const accountCmds = buildPerpCommands({ log: (m) => logs.push(m) });
    const api = {
      request: vi.fn(async () => ({
        marginSummary: { accountValue: '10', totalMarginUsed: '0' },
        withdrawable: '10',
        assetPositions: [],
        spotUsdc: '15.0',
      })),
    };
    await accountCmds.account([], api, {}, { wallet: 'x' });
    expect(logs.join('\n')).toContain('Spot USDC:       $15.0');
  });
});

describe('perp transfer (API-14)', () => {
  const base = { direction: 'spot-to-perp', amount: '25', wallet: 'x' };

  it('rejects an invalid --direction with a coded error', async () => {
    const err = await cmds.transfer([], null, {}, { ...base, direction: 'sideways' }).catch(e => e);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toMatch(/Invalid --direction "sideways"/);
  });

  it('rejects a non-numeric --amount', async () => {
    await expect(
      cmds.transfer([], null, {}, { ...base, amount: '25abc' }),
    ).rejects.toThrow(/Invalid --amount "25abc"/);
  });

  it('shows usage when --amount is missing', async () => {
    const { amount, ...noAmount } = base;
    void amount;
    await expect(
      cmds.transfer([], null, {}, noAmount),
    ).rejects.toThrow(/Usage: nansen perp transfer/);
  });

  it('rejects a duplicated --direction instead of crashing', async () => {
    const err = await cmds.transfer([], null, {}, { ...base, direction: ['spot-to-perp', 'perp-to-spot'] }).catch(e => e);
    expect(err.message).toMatch(/--direction was provided more than once/);
  });

  it('accepts a valid direction + amount (passes validation, fails later without a wallet)', async () => {
    await expect(
      cmds.transfer([], null, {}, { ...base }),
    ).rejects.not.toThrow(/Invalid --|Usage:/);
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

// ── Chunk 3/4/5: direct-to-HL build + screen + submit ────────────────
describe('perp direct-to-HL flow (Chunk 3/4/5)', () => {
  const WALLET = '0x' + '1'.repeat(40);
  const BUILDER = '0x' + 'Ab'.repeat(20); // mixed case → asserts lowercasing
  const KEY = '11'.repeat(32); // valid secp256k1 scalar; address is irrelevant here
  const ETH = { name: 'ETH', asset_id: 1, sz_decimals: 4, max_leverage: 50 };
  const baseOrder = { coin: 'ETH', side: 'buy', size: '0.01', price: '2000', type: 'market', wallet: 'x' };

  // Dispatch the proxy/screen calls by endpoint. `screen` is a function so a
  // test can make it throw (unavailable) or flag an address (sanctioned).
  function mockApi({ assets = [ETH], builder, screen }) {
    const builderStatus = builder ?? {
      approved: true,
      max_fee_rate: 80,
      required_fee: 80,
      builder_address: BUILDER,
    };
    return {
      request: vi.fn(async (endpoint, body) => {
        if (endpoint.startsWith('/api/v1/perp/meta')) return { assets };
        if (endpoint.startsWith('/api/v1/perp/builder-fee')) return builderStatus;
        if (endpoint.startsWith('/api/v1/perp/positions')) return { positions: [] };
        if (endpoint.startsWith('/api/v1/sanctions/screen')) return screen(body);
        throw new Error(`unexpected endpoint ${endpoint}`);
      }),
    };
  }

  const clean = () => ({ results: [{ address: WALLET, sanctioned: false }] });

  beforeEach(() => {
    submitExchange.mockClear();
    showWallet.mockReturnValue({ name: 'x', evm: WALLET, provider: 'local' });
    getWalletConfig.mockReturnValue({});
    exportWallet.mockReturnValue({ evm: { privateKey: KEY } });
  });

  it('aborts a sanctioned wallet before signing/submitting', async () => {
    const api = mockApi({ screen: () => ({ results: [{ address: WALLET, sanctioned: true }] }) });
    const err = await cmds.order([], api, {}, baseOrder).catch(e => e);
    expect(err.code).toBe('SANCTIONED');
    expect(submitExchange).not.toHaveBeenCalled();
  });

  it('fails closed when screening is unavailable', async () => {
    const api = mockApi({ screen: () => { throw new Error('503 SDN snapshot unavailable'); } });
    const err = await cmds.order([], api, {}, baseOrder).catch(e => e);
    expect(err.code).toBe('SCREENING_UNAVAILABLE');
    expect(submitExchange).not.toHaveBeenCalled();
  });

  it('fails closed when a requested address is absent from the screening result', async () => {
    const api = mockApi({ screen: () => ({ results: [] }) });
    const err = await cmds.order([], api, {}, baseOrder).catch(e => e);
    expect(err.code).toBe('SCREENING_UNAVAILABLE');
    expect(submitExchange).not.toHaveBeenCalled();
  });

  it('aborts with META_UNAVAILABLE when the asset is not listed', async () => {
    const api = mockApi({ assets: [], screen: clean });
    const err = await cmds.order([], api, {}, baseOrder).catch(e => e);
    expect(err.code).toBe('META_UNAVAILABLE');
    expect(submitExchange).not.toHaveBeenCalled();
  });

  it('submits an order carrying the lowercased builder code {b,f}', async () => {
    const api = mockApi({ screen: clean });
    await cmds.order([], api, {}, baseOrder);
    expect(submitExchange).toHaveBeenCalledTimes(1);
    const submitted = submitExchange.mock.calls[0][0];
    expect(submitted.action.type).toBe('order');
    expect(submitted.action.builder).toEqual({ b: BUILDER.toLowerCase(), f: 80 });
    expect(typeof submitted.nonce).toBe('number');
    expect(submitted.signature).toHaveProperty('r');
  });

  it('auto-fires the one-time builder-fee approval before the first order', async () => {
    const api = mockApi({
      builder: { approved: false, max_fee_rate: 0, required_fee: 80, builder_address: BUILDER },
      screen: clean,
    });
    await cmds.order([], api, {}, baseOrder);
    expect(submitExchange).toHaveBeenCalledTimes(2);
    expect(submitExchange.mock.calls[0][0].action.type).toBe('approveBuilderFee');
    expect(submitExchange.mock.calls[0][0].action.maxFeeRate).toBe('0.08%');
    expect(submitExchange.mock.calls[1][0].action.type).toBe('order');
  });

  it('screens and submits a transfer (user-signed usdClassTransfer)', async () => {
    const api = mockApi({ screen: clean });
    await cmds.transfer([], api, {}, { direction: 'spot-to-perp', amount: '25', wallet: 'x' });
    expect(submitExchange).toHaveBeenCalledTimes(1);
    expect(submitExchange.mock.calls[0][0].action.type).toBe('usdClassTransfer');
  });
});
