import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../wallet.js', () => ({
  showWallet: vi.fn(),
  getWalletConfig: vi.fn(() => ({})),
  exportWallet: vi.fn(),
}));

vi.mock('../keychain.js', () => ({
  retrievePassword: vi.fn(() => ({ password: null, source: null })),
}));

import { showWallet } from '../wallet.js';
import { buildBridgeCommands } from '../bridge.js';

// M7 / M6.2: --recipient and a base-unit --amount reached the API unchecked, with
// a 422 as the only backstop. Both are validated before the wallet is resolved,
// so these need no wallet — the assertions below rely on that ordering.

const cmds = buildBridgeCommands({ log: () => {} });

const base = {
  'from-chain': 'base',
  'to-chain': 'hyperliquid',
  'from-token': 'USDC',
  amount: '5000000',
  // Named so the "accepts" cases reach wallet resolution — the sentinel below is
  // how they prove validation passed.
  wallet: 'w',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Any resolution attempt should fail loudly, proving validation ran first.
  showWallet.mockImplementation(() => { throw new Error('wallet resolved too early'); });
});

describe('bridge quote --recipient validation', () => {
  it('rejects a truncated address', async () => {
    let err;
    try {
      await cmds.quote([], null, {}, { ...base, recipient: '0xabc' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('INVALID_ADDRESS');
    expect(err.message).toMatch(/Invalid --recipient "0xabc"/);
  });

  it('rejects a non-hex address of the right length', async () => {
    await expect(
      cmds.quote([], null, {}, { ...base, recipient: '0x' + 'zz'.repeat(20) }),
    ).rejects.toThrow(/Invalid --recipient/);
  });

  it('rejects a Solana address, which no supported destination takes', async () => {
    await expect(
      cmds.quote([], null, {}, { ...base, recipient: 'So11111111111111111111111111111111111111112' }),
    ).rejects.toThrow(/Invalid --recipient/);
  });

  it('accepts a well-formed EVM address', async () => {
    await expect(
      cmds.quote([], null, {}, { ...base, recipient: '0x' + 'ab'.repeat(20) }),
    ).rejects.toThrow(/wallet resolved too early/);
  });
});

describe('bridge quote --amount validation', () => {
  it('rejects a decimal in base units — a units mix-up, not a small amount', async () => {
    let err;
    try {
      await cmds.quote([], null, {}, { ...base, amount: '5.5' });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toMatch(/positive whole number/);
  });

  it('rejects trailing garbage', async () => {
    await expect(cmds.quote([], null, {}, { ...base, amount: '5000000abc' })).rejects.toThrow(
      /Invalid --amount/,
    );
  });

  it('rejects zero and negative amounts', async () => {
    await expect(cmds.quote([], null, {}, { ...base, amount: '0' })).rejects.toThrow(/Invalid --amount/);
    await expect(cmds.quote([], null, {}, { ...base, amount: '-1' })).rejects.toThrow(/Invalid --amount/);
  });

  it('accepts a base-unit integer', async () => {
    await expect(cmds.quote([], null, {}, { ...base })).rejects.toThrow(/wallet resolved too early/);
  });

  it('accepts a decimal with --amount-unit token', async () => {
    await expect(
      cmds.quote([], null, {}, { ...base, amount: '5.5', 'amount-unit': 'token' }),
    ).rejects.toThrow(/wallet resolved too early/);
  });

  it('still rejects garbage with --amount-unit set', async () => {
    await expect(
      cmds.quote([], null, {}, { ...base, amount: 'abc', 'amount-unit': 'usd' }),
    ).rejects.toThrow(/Must be a positive number when --amount-unit is usd/);
  });
});
