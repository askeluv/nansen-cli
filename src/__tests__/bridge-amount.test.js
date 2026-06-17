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
});
