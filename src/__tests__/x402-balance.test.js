/**
 * Tests for the x402 EVM payment-token registry used by balance checks.
 */

import { describe, it, expect } from 'vitest';
import { EVM_X402_TOKENS, EVM_X402_RPCS } from '../x402.js';

describe('EVM_X402_TOKENS registry', () => {
  it('covers Base, X Layer, and BNB Smart Chain', () => {
    expect(Object.keys(EVM_X402_TOKENS).sort()).toEqual(
      ['eip155:196', 'eip155:56', 'eip155:8453'],
    );
  });

  it('lists the four BSC stablecoins with eip3009-capable tokens first', () => {
    const symbols = EVM_X402_TOKENS['eip155:56'].map(t => t.symbol);
    expect(symbols).toEqual(['U', 'USD1', 'USDT', 'USDC']);
  });

  it('uses 18 decimals for every BSC token and 6 elsewhere', () => {
    for (const t of EVM_X402_TOKENS['eip155:56']) {
      expect(t.decimals, t.symbol).toBe(18);
    }
    expect(EVM_X402_TOKENS['eip155:8453'][0].decimals).toBe(6);
    expect(EVM_X402_TOKENS['eip155:196'][0].decimals).toBe(6);
  });

  it('pins the expected token contracts', () => {
    expect(EVM_X402_TOKENS['eip155:8453'][0].token)
      .toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'); // Base USDC
    const bsc = Object.fromEntries(
      EVM_X402_TOKENS['eip155:56'].map(t => [t.symbol, t.token]),
    );
    expect(bsc.U).toBe('0xcE24439F2D9C6a2289F741120FE202248B666666');
    expect(bsc.USD1).toBe('0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d');
    expect(bsc.USDT).toBe('0x55d398326f99059fF775485246999027B3197955');
    expect(bsc.USDC).toBe('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d');
  });

  it('resolves an RPC URL for every network', () => {
    for (const network of Object.keys(EVM_X402_TOKENS)) {
      expect(EVM_X402_RPCS[network], `rpc for ${network}`).toMatch(/^https?:\/\//);
    }
  });
});

describe('checkX402Balance BigInt precision (18 decimals)', () => {
  it('returns correct balance for wei values above MAX_SAFE_INTEGER', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const mockHex = '0x00000000000000000000000000000000000000000000000572b7b98736c20000';
    const mockWallets = {
      defaultWallet: 'test',
      wallets: [{ name: 'test', evm: '0x' + '11'.repeat(20) }],
    };
    vi.doMock('../wallet.js', () => ({
      listWallets: () => mockWallets,
      exportWallet: vi.fn(),
    }));
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: mockHex }),
    });

    const { checkX402Balance } = await import('../x402.js');
    const result = await checkX402Balance('eip155:56', '0x55d398326f99059fF775485246999027B3197955');

    expect(result).not.toBeNull();
    expect(result.symbol).toBe('USDT');
    expect(result.balance).toBeCloseTo(100.5, 1);

    vi.doUnmock('../wallet.js');
    delete global.fetch;
  });

  it('returns zero balance when eth_call returns null', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const mockWallets = {
      defaultWallet: 'test',
      wallets: [{ name: 'test', evm: '0x' + '11'.repeat(20) }],
    };
    vi.doMock('../wallet.js', () => ({
      listWallets: () => mockWallets,
      exportWallet: vi.fn(),
    }));
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: null }),
    });

    const { checkX402Balance } = await import('../x402.js');
    const result = await checkX402Balance('eip155:56');

    expect(result).toEqual({ balance: 0, symbol: 'U' });

    vi.doUnmock('../wallet.js');
    delete global.fetch;
  });
});
