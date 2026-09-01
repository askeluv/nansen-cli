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

describe('createPaymentSignatures — policy guard integration', () => {
  // Canonical Base USDC requirement used across integration tests.
  // The `pay_to` and `payTo` fields are set to the same value to cover both field names.
  const BASE_USDC_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  function makeRequirement(amountBaseUnits) {
    return {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: BASE_USDC_ASSET,
      amount: String(amountBaseUnits),
      pay_to: '0xRecipient',
      payTo: '0xRecipient',
      extra: { name: 'USD Coin', version: '2' },
      maxTimeoutSeconds: 120,
    };
  }

  function makeResponse(requirement) {
    const payload = { accepts: [requirement] };
    const header = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    return {
      headers: { get: (k) => (k === 'payment-required' ? header : null) },
    };
  }

  // Fake exported wallet with dummy key material (no real signing needed —
  // createEvmPaymentPayload is mocked).
  const FAKE_EXPORTED = {
    evm: { privateKey: '0x' + 'aa'.repeat(32), address: '0xFakeAddress' },
    solana: { privateKey: new Uint8Array(64), address: 'FakeSolanaAddr' },
  };

  let mockFetch;
  let consoleErrorSpy;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);
    vi.resetModules();

    // Mock wallet.js for all paths (createPaymentSignatures + getWalletConfig in policy).
    vi.doMock('../wallet.js', () => ({
      listWallets: () => ({
        defaultWallet: 'test',
        wallets: [{ name: 'test', evm: '0xFakeAddress', solana: 'FakeSolanaAddr' }],
      }),
      exportWallet: () => FAKE_EXPORTED,
      getWalletConfig: () => ({ passwordHash: null }),
    }));

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../wallet.js');
    consoleErrorSpy.mockRestore();
    delete process.env.NANSEN_X402_MAX_AMOUNT;
  });

  it('11. over-cap amount → yields nothing, logs refusal, createEvmPaymentPayload not called', async () => {
    // $1001 worth of USDC (6 decimals) = well above the $1.00 default cap
    const overCapAmount = 1_001_000_000n; // $1001
    const req = makeRequirement(overCapAmount);

    const createEvmSpy = vi.fn().mockReturnValue('fake-sig');
    vi.doMock('../x402-evm.js', () => ({
      createEvmPaymentPayload: createEvmSpy,
      isEvmNetwork: (n) => n.startsWith('eip155:'),
      PERMIT2_ADDRESS: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    }));
    vi.doMock('../x402-svm.js', () => ({
      createSvmPaymentPayload: vi.fn(),
      isSvmNetwork: () => false,
      fetchRecentBlockhash: vi.fn(),
      getSolanaRpcUrl: vi.fn(),
    }));

    const { createPaymentSignatures } = await import('../x402.js');
    const response = makeResponse(req);

    const results = [];
    for await (const item of createPaymentSignatures(response, 'https://api.nansen.ai/test')) {
      results.push(item);
    }

    expect(results).toHaveLength(0);
    expect(createEvmSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Refusing to auto-pay'),
    );

    vi.doUnmock('../x402-evm.js');
    vi.doUnmock('../x402-svm.js');
  });

  it('12. within-cap amount → yields one signature, createEvmPaymentPayload is called', async () => {
    // $0.01 worth of USDC = 10_000 base units, well within the $1.00 cap
    const withinCapAmount = 10_000n;
    const req = makeRequirement(withinCapAmount);

    const createEvmSpy = vi.fn().mockReturnValue('fake-sig-ok');
    vi.doMock('../x402-evm.js', () => ({
      createEvmPaymentPayload: createEvmSpy,
      isEvmNetwork: (n) => n.startsWith('eip155:'),
      PERMIT2_ADDRESS: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    }));
    vi.doMock('../x402-svm.js', () => ({
      createSvmPaymentPayload: vi.fn(),
      isSvmNetwork: () => false,
      fetchRecentBlockhash: vi.fn(),
      getSolanaRpcUrl: vi.fn(),
    }));

    const { createPaymentSignatures } = await import('../x402.js');
    const response = makeResponse(req);

    const results = [];
    for await (const item of createPaymentSignatures(response, 'https://api.nansen.ai/test')) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(createEvmSpy).toHaveBeenCalledTimes(1);
    // No refusal logged
    const refusalLogged = consoleErrorSpy.mock.calls.some(
      args => String(args[0]).includes('Refusing to auto-pay'),
    );
    expect(refusalLogged).toBe(false);

    vi.doUnmock('../x402-evm.js');
    vi.doUnmock('../x402-svm.js');
  });

  it('13. permit2-exact preflight checks allowance against resolvePaymentAmount, not raw empty amount', async () => {
    // Regression: hasPermit2Allowance must be called with the guard's resolved
    // amount, not requirement.amount directly — otherwise amount: "" coerces to
    // 0n via BigInt("") and the allowance check is silently skipped.
    const req = {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: BASE_USDC_ASSET,
      amount: '',
      maxAmountRequired: '10000', // $0.01 — within the $1.00 default cap
      pay_to: '0xRecipient',
      payTo: '0xRecipient',
      extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2-exact' },
      maxTimeoutSeconds: 120,
    };

    // Real (non-zero) allowance is 0; a correct preflight against the
    // resolved $0.01 amount must reject this option.
    mockFetch.mockResolvedValue({ json: async () => ({ result: '0x0' }) });

    const createEvmSpy = vi.fn().mockReturnValue('fake-sig');
    vi.doMock('../x402-evm.js', () => ({
      createEvmPaymentPayload: createEvmSpy,
      isEvmNetwork: (n) => n.startsWith('eip155:'),
      PERMIT2_ADDRESS: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    }));
    vi.doMock('../x402-svm.js', () => ({
      createSvmPaymentPayload: vi.fn(),
      isSvmNetwork: () => false,
      fetchRecentBlockhash: vi.fn(),
      getSolanaRpcUrl: vi.fn(),
    }));

    const { createPaymentSignatures } = await import('../x402.js');
    const response = makeResponse(req);

    const results = [];
    for await (const item of createPaymentSignatures(response, 'https://api.nansen.ai/test')) {
      results.push(item);
    }

    expect(results).toHaveLength(0);
    expect(createEvmSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing or below the payment amount (10000)'),
    );

    vi.doUnmock('../x402-evm.js');
    vi.doUnmock('../x402-svm.js');
  });
});

describe('parsePaymentRequirements — UTF-8 decode', () => {
  // Regression: atob() returns a Latin-1 binary string, which corrupts
  // multi-byte UTF-8 chars like ₮ (0xE2 0x82 0xAE) in extra.name = 'USD₮0'.
  // The corrupted name then signs the wrong EIP-712 domain and the server
  // rejects with invalid_exact_evm_signature.
  it('preserves UTF-8 chars in payment requirement fields (e.g. USD₮0)', async () => {
    const { parsePaymentRequirements } = await import('../x402.js');
    const requirements = {
      accepts: [{
        scheme: 'exact',
        network: 'eip155:196',
        asset: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736',
        extra: { name: 'USD₮0', version: '1' },
      }],
    };
    const header = Buffer.from(JSON.stringify(requirements), 'utf8').toString('base64');
    const response = { headers: { get: (k) => k === 'payment-required' ? header : null } };

    const parsed = parsePaymentRequirements(response);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].extra.name).toBe('USD₮0');
  });
});
