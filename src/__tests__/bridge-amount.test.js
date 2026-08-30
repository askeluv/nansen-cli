import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../wallet.js', () => ({
  showWallet: vi.fn(() => ({ evm: '0x' + 'a'.repeat(40), provider: 'local' })),
  getWalletConfig: vi.fn(() => ({})),
  exportWallet: vi.fn(),
}));

import {
  buildBridgeCommands,
  resolveBridgeTokenDecimals,
  floorHyperliquidUsdcBridgeAmount,
} from '../bridge.js';

const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const HL_USDC = '0x00000000000000000000000000000000';

describe('resolveBridgeTokenDecimals', () => {
  it('returns 8 for Hyperliquid USDC', async () => {
    expect(await resolveBridgeTokenDecimals(HL_USDC, 'hyperliquid')).toBe(8);
  });

  it('returns 6 for EVM USDC', async () => {
    expect(await resolveBridgeTokenDecimals(BASE_USDC, 'base')).toBe(6);
  });

  it('throws for a non-USDC token on Hyperliquid (no decimals source)', async () => {
    await expect(
      resolveBridgeTokenDecimals('0x' + '1'.repeat(40), 'hyperliquid'),
    ).rejects.toThrow(/Cannot resolve decimals/);
  });
});

describe('floorHyperliquidUsdcBridgeAmount', () => {
  it('floors HL USDC (8 dec) down to 6-decimal precision', () => {
    // 27.17457999 USDC at 8 decimals -> floor dust below 1e-6
    expect(floorHyperliquidUsdcBridgeAmount('2717457999', 8, HL_USDC, 'hyperliquid')).toBe('2717457900');
  });

  it('leaves an already-6-decimal-aligned HL amount unchanged', () => {
    expect(floorHyperliquidUsdcBridgeAmount('500000000', 8, HL_USDC, 'hyperliquid')).toBe('500000000');
  });

  it('passes non-Hyperliquid amounts through untouched', () => {
    expect(floorHyperliquidUsdcBridgeAmount('5000000', 6, BASE_USDC, 'base')).toBe('5000000');
  });
});

describe('bridge quote --amount-unit (M2)', () => {
  let tmpHome;
  let prevHome;

  beforeEach(() => {
    prevHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-bridge-amt-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function fakeApi() {
    const captured = {};
    return {
      captured,
      request: async (_path, params) => {
        captured.params = params;
        return { details: {}, fees: {}, steps: [] };
      },
    };
  }

  it('converts the same human amount to per-chain base units (HL 8 vs Base 6)', async () => {
    const cmds = buildBridgeCommands({ log: () => {} });

    const hlApi = fakeApi();
    await cmds.quote([], hlApi, {}, {
      'from-chain': 'hyperliquid', 'to-chain': 'base',
      'from-token': 'USDC', amount: '5', 'amount-unit': 'token', wallet: 'w',
    });
    expect(hlApi.captured.params.amount).toBe('500000000'); // 5 * 10^8

    const baseApi = fakeApi();
    await cmds.quote([], baseApi, {}, {
      'from-chain': 'base', 'to-chain': 'hyperliquid',
      'from-token': 'USDC', amount: '5', 'amount-unit': 'token', wallet: 'w',
    });
    expect(baseApi.captured.params.amount).toBe('5000000'); // 5 * 10^6
  });

  it('passes --amount through unchanged when no --amount-unit is given (base units)', async () => {
    const cmds = buildBridgeCommands({ log: () => {} });
    const api = fakeApi();
    await cmds.quote([], api, {}, {
      'from-chain': 'base', 'to-chain': 'hyperliquid',
      'from-token': 'USDC', amount: '5000000', wallet: 'w',
    });
    expect(api.captured.params.amount).toBe('5000000');
  });

  // Regression: the default base-units path used to skip the HL-USDC 6dp floor
  // (only --amount-unit floored). Relay formats sendAsset to 6dp, so an unfloored
  // 8-dp request whose last two digits are non-zero (here residue 50, the
  // rounding boundary) got rejected at execute time — both by the currencyIn
  // equality check and the amount cap — on a withdrawal the user legitimately
  // asked for. Floor here so the persisted amount matches what the quote sends.
  it('floors an HL-origin base-units amount at the 6dp rounding boundary (residue 50)', async () => {
    const cmds = buildBridgeCommands({ log: () => {} });
    const api = fakeApi();
    await cmds.quote([], api, {}, {
      'from-chain': 'hyperliquid', 'to-chain': 'base',
      'from-token': 'USDC', amount: '200000050', wallet: 'w',
    });
    expect(api.captured.params.amount).toBe('200000000');
    // The persisted anchor that execute's amount checks compare against must be
    // the floored value too, not the unfloored request.
    const quotesDir = path.join(tmpHome, '.nansen', 'quotes');
    const file = fs.readdirSync(quotesDir).find(f => f.startsWith('bridge-'));
    const saved = JSON.parse(fs.readFileSync(path.join(quotesDir, file), 'utf8'));
    expect(saved.requestedAmountBaseUnits).toBe('200000000');
  });

  it('leaves an already-6dp-aligned HL-origin base-units amount unchanged', async () => {
    const cmds = buildBridgeCommands({ log: () => {} });
    const api = fakeApi();
    await cmds.quote([], api, {}, {
      'from-chain': 'hyperliquid', 'to-chain': 'base',
      'from-token': 'USDC', amount: '200000000', wallet: 'w',
    });
    expect(api.captured.params.amount).toBe('200000000');
  });

  it('rejects an unknown --amount-unit instead of silently using base units', async () => {
    const cmds = buildBridgeCommands({ log: () => {} });
    const api = fakeApi();
    await expect(
      cmds.quote([], api, {}, {
        'from-chain': 'base', 'to-chain': 'hyperliquid',
        'from-token': 'USDC', amount: '5', 'amount-unit': 'tokens', wallet: 'w',
      }),
    ).rejects.toThrow(/Invalid --amount-unit/);
    expect(api.captured.params).toBeUndefined();
  });

  it('accepts a case-insensitive --amount-unit', async () => {
    const cmds = buildBridgeCommands({ log: () => {} });
    const api = fakeApi();
    await cmds.quote([], api, {}, {
      'from-chain': 'base', 'to-chain': 'hyperliquid',
      'from-token': 'USDC', amount: '5', 'amount-unit': 'Token', wallet: 'w',
    });
    expect(api.captured.params.amount).toBe('5000000');
  });

  // --amount-unit usd on USDC must NOT call the price API: USDC is $1, and HL's
  // USDC uses a sentinel address the price API can't resolve. fakeApi() has no
  // generalSearch, so reaching resolveUsdPrice would throw — passing proves the
  // $1 short-circuit fired.
  it('treats USDC as $1 for --amount-unit usd from Hyperliquid (no price lookup)', async () => {
    const cmds = buildBridgeCommands({ log: () => {} });
    const api = fakeApi();
    await cmds.quote([], api, {}, {
      'from-chain': 'hyperliquid', 'to-chain': 'base',
      'from-token': 'USDC', amount: '5', 'amount-unit': 'usd', wallet: 'w',
    });
    expect(api.captured.params.amount).toBe('500000000'); // $5 -> 5 USDC at 8 dec
  });

  it('treats USDC as $1 for --amount-unit usd on an EVM chain (no price lookup)', async () => {
    const cmds = buildBridgeCommands({ log: () => {} });
    const api = fakeApi();
    await cmds.quote([], api, {}, {
      'from-chain': 'base', 'to-chain': 'hyperliquid',
      'from-token': 'USDC', amount: '5', 'amount-unit': 'usd', wallet: 'w',
    });
    expect(api.captured.params.amount).toBe('5000000'); // $5 -> 5 USDC at 6 dec
  });
});

// The CLI offers a deliberately narrower, asymmetric route set than the API
// accepts: deposits need a locally signable origin chain (Base only), while
// withdrawals sign an HL action and so work to any API-supported destination.
describe('bridge quote supported routes', () => {
  let tmpHome;
  let prevHome;

  beforeEach(() => {
    prevHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-bridge-routes-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function fakeApi() {
    const captured = {};
    return {
      captured,
      request: async (_path, params) => {
        captured.params = params;
        return { details: {}, fees: {}, steps: [] };
      },
    };
  }

  function quoteWith(api, fromChain, toChain) {
    return buildBridgeCommands({ log: () => {} }).quote([], api, {}, {
      'from-chain': fromChain, 'to-chain': toChain,
      'from-token': 'USDC', amount: '5000000', wallet: 'w',
    });
  }

  // The bug this guards: these origins have RPCs, chain IDs and USDC addresses
  // wired, so a quote used to succeed and only blow up at execute time inside
  // signEvmTransaction ("Unsupported EVM chain"), after the user had a quote
  // file in hand. Reject at quote time instead.
  for (const origin of ['ethereum', 'arbitrum', 'polygon', 'bnb']) {
    it(`rejects a ${origin} -> hyperliquid deposit (not locally signable)`, async () => {
      const api = fakeApi();
      await expect(quoteWith(api, origin, 'hyperliquid')).rejects.toThrow(
        /Unsupported bridge route/,
      );
      expect(api.captured.params).toBeUndefined();
    });
  }

  it('accepts the base -> hyperliquid deposit', async () => {
    const api = fakeApi();
    await quoteWith(api, 'base', 'hyperliquid');
    expect(api.captured.params.origin_chain).toBe('base');
  });

  for (const destination of ['base', 'ethereum', 'arbitrum']) {
    it(`accepts the hyperliquid -> ${destination} withdrawal`, async () => {
      const api = fakeApi();
      await quoteWith(api, 'hyperliquid', destination);
      expect(api.captured.params.destination_chain).toBe(destination);
    });
  }

  // Mirrors the API's own pair matrix, which has no HL -> polygon/bnb route.
  for (const destination of ['polygon', 'bnb']) {
    it(`rejects the hyperliquid -> ${destination} withdrawal`, async () => {
      const api = fakeApi();
      await expect(quoteWith(api, 'hyperliquid', destination)).rejects.toThrow(
        /Unsupported bridge route/,
      );
      expect(api.captured.params).toBeUndefined();
    });
  }

  it('rejects an EVM -> EVM route (not a Hyperliquid bridge)', async () => {
    const api = fakeApi();
    await expect(quoteWith(api, 'base', 'arbitrum')).rejects.toThrow(
      /Unsupported bridge route/,
    );
    expect(api.captured.params).toBeUndefined();
  });

  it('lists the supported routes in the rejection message', async () => {
    await expect(quoteWith(fakeApi(), 'polygon', 'hyperliquid')).rejects.toThrow(
      /base -> hyperliquid/,
    );
  });
});
