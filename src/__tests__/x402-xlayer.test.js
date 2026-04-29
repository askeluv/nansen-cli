/**
 * Tests for X Layer x402 payment support
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEvmPaymentPayload, isEvmNetwork } from '../x402-evm.js';
import { generateEvmWallet } from '../wallet.js';
import * as walletModule from '../wallet.js';

describe('x402 EVM with X Layer (eip155:196)', () => {
  it('isEvmNetwork recognizes X Layer', () => {
    expect(isEvmNetwork('eip155:196')).toBe(true);
  });

  it('createEvmPaymentPayload produces valid payload for X Layer USDG', () => {
    const wallet = generateEvmWallet();
    const requirements = {
      scheme: 'exact',
      network: 'eip155:196',
      asset: '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8',
      amount: '100000',
      pay_to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      extra: { name: 'USDG', version: '1' },
    };

    const result = createEvmPaymentPayload(
      requirements,
      wallet.privateKey,
      wallet.address,
      'https://api.nansen.ai/v1/test',
    );

    const decoded = JSON.parse(Buffer.from(result, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted.network).toBe('eip155:196');
    expect(decoded.accepted.asset).toBe('0x4ae46a509f6b1d9056937ba4500cb143933d2dc8');
    expect(decoded.payload.authorization.from).toBe(wallet.address);
    expect(decoded.payload.signature).toMatch(/^0x/);
  });

  it('createEvmPaymentPayload produces valid payload for X Layer USDT', () => {
    const wallet = generateEvmWallet();
    const requirements = {
      scheme: 'exact',
      network: 'eip155:196',
      asset: '0x779ded0c9e1022225f8e0630b35a9b54be713736',
      amount: '50000',
      pay_to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      extra: { name: 'USDT', version: '1' },
    };

    const result = createEvmPaymentPayload(
      requirements,
      wallet.privateKey,
      wallet.address,
      'https://api.nansen.ai/v1/test',
    );

    const decoded = JSON.parse(Buffer.from(result, 'base64').toString('utf8'));
    expect(decoded.accepted.network).toBe('eip155:196');
    expect(decoded.accepted.asset).toBe('0x779ded0c9e1022225f8e0630b35a9b54be713736');
  });
});

describe('checkX402Balance with X Layer', () => {
  let mockFetch;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    vi.spyOn(walletModule, 'listWallets').mockReturnValue({
      defaultWallet: 'test',
      wallets: [{ name: 'test', evm: '0x1234567890abcdef1234567890abcdef12345678' }],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('queries the correct RPC and asset for X Layer (eip155:196)', async () => {
    // Balance = 5.0 USDG (5000000 raw, 6 decimals)
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' + (5000000).toString(16) }),
    });

    const { checkX402Balance } = await import('../x402.js');
    const balance = await checkX402Balance(
      'eip155:196',
      '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8',
    );

    expect(balance).toBe(5);

    // Verify fetch was called with X Layer RPC (okx.com), not Base RPC
    const [fetchUrl, fetchOpts] = mockFetch.mock.calls[0];
    expect(fetchUrl).toContain('xlayerrpc.okx.com');
    const fetchBody = JSON.parse(fetchOpts.body);
    expect(fetchBody.params[0].to).toBe('0x4ae46a509f6b1d9056937ba4500cb143933d2dc8');
  });

  it('returns null for unknown EVM chain', async () => {
    const { checkX402Balance } = await import('../x402.js');
    const balance = await checkX402Balance('eip155:99999', '0xdeadbeef');
    expect(balance).toBeNull();
  });

  it('falls back to Base USDC when asset is not provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' + (1000000).toString(16) }),
    });

    const { checkX402Balance } = await import('../x402.js');
    const balance = await checkX402Balance('eip155:8453');
    expect(balance).toBe(1);

    const [, fetchOpts] = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse(fetchOpts.body);
    expect(fetchBody.params[0].to).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  });
});
