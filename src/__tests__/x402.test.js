/**
 * Tests for src/x402.js — specifically `checkX402Balance()` per-network lookup.
 *
 * Covers the EVM_NETWORKS table at src/x402.js:195: each supported network
 * must hit the right token contract on the right RPC and report the right
 * symbol, and an unknown EVM network must fall back to Base USDC so existing
 * wallets keep working when the API advertises a new network we don't yet
 * recognise. Regression for the original wrong X Layer USDT0 address (the
 * hardcoded value pointed at a phantom contract — `eth_call` returned `0x` —
 * so the warning silently never fired for X Layer wallets).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 1.5 USDC / USDT0 (6 decimals) → balance check should report 1.5
const RPC_RESULT_1_5 = '0x' + (1_500_000n).toString(16);

const TEST_WALLET = {
  name: 'test',
  evm: '0xAbCdEf0123456789abCDef0123456789abCDef01',
  solana: 'SoLanaAddr1111111111111111111111111111111',
};

function mockWalletModule() {
  vi.doMock('../wallet.js', () => ({
    listWallets: () => ({
      defaultWallet: TEST_WALLET.name,
      wallets: [TEST_WALLET],
    }),
    exportWallet: () => { throw new Error('not used by checkX402Balance'); },
    getWalletConfig: () => ({ passwordHash: null }),
  }));
}

describe('checkX402Balance — EVM per-network lookup', () => {
  let mockFetch;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    vi.resetModules();
    mockWalletModule();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../wallet.js');
  });

  it('returns USDC balance + symbol for Base (eip155:8453) and queries the right contract on the Base RPC', async () => {
    mockFetch.mockResolvedValue({ json: async () => ({ result: RPC_RESULT_1_5 }) });
    const { checkX402Balance } = await import('../x402.js');
    const { CHAIN_RPCS } = await import('../rpc-urls.js');

    const result = await checkX402Balance('eip155:8453');

    expect(result).toEqual({ balance: 1.5, symbol: 'USDC' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(CHAIN_RPCS.base);
    const body = JSON.parse(init.body);
    expect(body.method).toBe('eth_call');
    // Base USDC contract — must not regress to USDT0 or any other address
    expect(body.params[0].to).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    // ERC-20 balanceOf(walletAddr), zero-padded to 32 bytes
    expect(body.params[0].data).toBe(
      '0x70a08231' + TEST_WALLET.evm.replace('0x', '').toLowerCase().padStart(64, '0'),
    );
  });

  it('returns USDT0 balance + symbol for X Layer (eip155:196) and queries the right contract on the X Layer RPC', async () => {
    // Regression: an earlier version of this code used a phantom USDT0
    // address (`0x779DED2B…7736`) — `eth_call` returned `0x` and parseInt(0x, 16)
    // was NaN, so the warning silently never fired for X Layer wallets.
    mockFetch.mockResolvedValue({ json: async () => ({ result: RPC_RESULT_1_5 }) });
    const { checkX402Balance } = await import('../x402.js');
    const { CHAIN_RPCS } = await import('../rpc-urls.js');

    const result = await checkX402Balance('eip155:196');

    expect(result).toEqual({ balance: 1.5, symbol: 'USDT0' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(CHAIN_RPCS.xlayer);
    const body = JSON.parse(init.body);
    // X Layer USDT0 — pinned literal so a typo regresses the test, not silently the prod path
    expect(body.params[0].to).toBe('0x779Ded0c9e1022225f8E0630b35a9b54bE713736');
  });

  it('falls back to Base USDC for an unknown EVM network', async () => {
    // The fallback exists so existing Base-funded wallets keep getting balance
    // warnings if the API ever advertises a network we don't yet recognise.
    mockFetch.mockResolvedValue({ json: async () => ({ result: RPC_RESULT_1_5 }) });
    const { checkX402Balance } = await import('../x402.js');
    const { CHAIN_RPCS } = await import('../rpc-urls.js');

    const result = await checkX402Balance('eip155:99999');

    expect(result).toEqual({ balance: 1.5, symbol: 'USDC' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(CHAIN_RPCS.base);
    expect(JSON.parse(init.body).params[0].to).toBe(
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    );
  });

  it('returns null when the RPC call throws', async () => {
    // Generic error path — checkX402Balance is best-effort; warnings are
    // optional. A network blip should never bubble up to the user.
    mockFetch.mockRejectedValue(new Error('RPC down'));
    const { checkX402Balance } = await import('../x402.js');

    const result = await checkX402Balance('eip155:8453');

    expect(result).toBeNull();
  });
});
