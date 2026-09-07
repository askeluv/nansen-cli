/**
 * Tests for limit-order module
 *
 * Covers: JWT caching, API client functions, message signing dispatch,
 * command handlers (create, list, cancel, update), expiry parsing,
 * wallet resolution, and error handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

import {
  loadCachedToken,
  saveCachedToken,
  authenticate,
  signSolanaMessage,
  resolveSolanaWallet,
  parseExpiry,
  buildLimitOrderCommands,
  getChallenge,
  verifyChallenge,
  getVault,
  registerVault,
  craftDeposit,
  createOrder,
  listOrders,
  updateOrder,
  cancelOrderRequest,
  confirmCancelOrder,
} from '../limit-order.js';
import { createWallet, base58Decode, generateSolanaWallet } from '../wallet.js';
import { SIMULATION_RPCS } from '../rpc-urls.js';

let originalHome;
let tempDir;
let originalFetch;
let originalSolanaSimRpc;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-lo-test-'));
  process.env.HOME = tempDir;
  originalFetch = global.fetch;
  global.fetch = vi.fn();
  // Force limit-order outcome verification to gracefully degrade by default so
  // existing happy-path tests (which don't mock the sim RPC's own fetch calls)
  // stay green. Tests that exercise the outcome layer itself set this back to
  // a truthy value locally.
  originalSolanaSimRpc = SIMULATION_RPCS.solana;
  SIMULATION_RPCS.solana = null;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
  global.fetch = originalFetch;
  SIMULATION_RPCS.solana = originalSolanaSimRpc;
  vi.restoreAllMocks();
});

// ============= Helper =============

function mockFetchResponse(response, status = 200) {
  global.fetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(response),
  });
}

function mockFetchSequence(responses) {
  for (const { body, status = 200 } of responses) {
    mockFetchResponse(body, status);
  }
}

// Create a local test wallet (unencrypted)
function createTestWallet(name = 'test-wallet') {
  return createWallet(name, null);
}

// We need child_process mocked for walletconnect.
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

function getAuthFilePath() {
  return path.join(tempDir, '.nansen', 'limit-order-auth.json');
}

function writeAuthFile(data) {
  const filePath = getAuthFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
}

describe('JWT caching (local file)', () => {
  it('loadCachedToken returns null when no file exists', () => {
    expect(loadCachedToken('somePubkey')).toBeNull();
  });

  it('loadCachedToken returns null when pubkey does not match', () => {
    saveCachedToken('pubkey-A', 'jwt-token-A');
    expect(loadCachedToken('pubkey-B')).toBeNull();
  });

  it('loadCachedToken returns null when token is expired', () => {
    writeAuthFile({
      walletPubkey: 'pubkey',
      token: 'expired-token',
      expiresAt: Date.now() - 1000,
    });
    expect(loadCachedToken('pubkey')).toBeNull();
  });

  it('loadCachedToken returns null when within 5-min buffer of expiry', () => {
    writeAuthFile({
      walletPubkey: 'pubkey',
      token: 'almost-expired-token',
      expiresAt: Date.now() + 60_000, // 1 minute left, within 5-min buffer
    });
    expect(loadCachedToken('pubkey')).toBeNull();
  });

  it('saveCachedToken + loadCachedToken roundtrip', () => {
    saveCachedToken('myPubkey', 'jwt-abc-123');
    const token = loadCachedToken('myPubkey');
    expect(token).toBe('jwt-abc-123');
  });

  it('saveCachedToken overwrites previous token', () => {
    saveCachedToken('pubkey', 'token-1');
    saveCachedToken('pubkey', 'token-2');
    expect(loadCachedToken('pubkey')).toBe('token-2');
  });

  it('loadCachedToken returns null gracefully when file is corrupted', () => {
    const filePath = getAuthFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, 'not json');
    expect(loadCachedToken('pubkey')).toBeNull();
  });
});

// ============= Expiry Parsing =============

describe('parseExpiry', () => {
  it('parses hours', () => {
    const before = Date.now();
    const result = parseExpiry('24h');
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before + 24 * 3600 * 1000);
    expect(result).toBeLessThanOrEqual(after + 24 * 3600 * 1000);
  });

  it('parses days', () => {
    const before = Date.now();
    const result = parseExpiry('7d');
    expect(result).toBeGreaterThanOrEqual(before + 7 * 24 * 3600 * 1000);
  });

  it('parses 30d default', () => {
    const result = parseExpiry('30d');
    expect(result).toBeGreaterThan(Date.now());
  });

  it('returns null for "never"', () => {
    expect(parseExpiry('never')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(parseExpiry(null)).toBeNull();
    expect(parseExpiry(undefined)).toBeNull();
  });

  it('parses raw epoch ms', () => {
    const future = Date.now() + 86400000;
    expect(parseExpiry(String(future))).toBe(future);
  });

  it('throws for invalid format', () => {
    expect(() => parseExpiry('invalid')).toThrow('Invalid expiry format');
    expect(() => parseExpiry('abc123')).toThrow('Invalid expiry format');
  });

  it('rejects a zero-duration expiry (L5)', () => {
    expect(() => parseExpiry('0h')).toThrow(/greater than 0/);
    expect(() => parseExpiry('0d')).toThrow(/greater than 0/);
  });

  it('rejects a past epoch (L5)', () => {
    const past = Date.now() - 3600000;
    expect(() => parseExpiry(String(past))).toThrow(/in the past/);
  });

  it.each([
    'Infinity',
    '-Infinity',
    '1e309',
  ])('rejects non-finite raw expiry value %s', (value) => {
    expect(() => parseExpiry(value)).toThrow(/Invalid expiry/);
  });

  it('rejects an expiry duration that overflows to Infinity', () => {
    expect(() => parseExpiry(`${'9'.repeat(400)}h`)).toThrow(/Invalid expiry/);
  });
});

// ============= API Client Functions =============

describe('API client', () => {
  it('getChallenge sends correct request', async () => {
    mockFetchResponse({ challenge: 'sign this message' });
    const result = await getChallenge('myPubkey');
    expect(result.challenge).toBe('sign this message');

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/limit-order/v2/auth/challenge');
    expect(JSON.parse(opts.body)).toEqual({ walletPubkey: 'myPubkey' });
    // The client sends X-API-Key / Bearer JWT; never follow a redirect that
    // could relay them to another host.
    expect(opts.redirect).toBe('error');
  });

  it('verifyChallenge sends correct request', async () => {
    mockFetchResponse({ token: 'jwt-token-123' });
    const result = await verifyChallenge('myPubkey', 'sigBase58');
    expect(result.token).toBe('jwt-token-123');

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/limit-order/v2/auth/verify');
    expect(JSON.parse(opts.body)).toEqual({ walletPubkey: 'myPubkey', signature: 'sigBase58' });
  });

  it('getVault sends correct query params', async () => {
    mockFetchResponse({ vaultPubkey: 'vault123', userPubkey: 'pub1' });
    const result = await getVault('jwt-token', 'pub1');
    expect(result.vaultPubkey).toBe('vault123');

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('userPubkey=pub1');
    expect(opts.headers['Authorization']).toBe('Bearer jwt-token');
  });

  it('registerVault sends POST with auth', async () => {
    mockFetchResponse({ vaultAddress: 'vault456', userPubkey: 'pub1' });
    await registerVault('jwt-token');

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/limit-order/v2/vault/register');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Authorization']).toBe('Bearer jwt-token');
  });

  it('craftDeposit sends correct body', async () => {
    mockFetchResponse({ transaction: 'dHhCYXNlNjQ=', requestId: 'req-1' });
    const result = await craftDeposit('jwt', {
      inputMint: 'So111',
      outputMint: 'EPjFW',
      userAddress: 'pub1',
      amount: '1000000',
    });
    expect(result.requestId).toBe('req-1');

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.inputMint).toBe('So111');
    expect(body.amount).toBe('1000000');
  });

  it('createOrder sends triggerPriceUsd as number', async () => {
    mockFetchResponse({ id: 'order-1', txSignature: 'sig123' });
    await createOrder('jwt', {
      orderType: 'single',
      depositRequestId: 'req-1',
      depositSignedTx: 'signed-base64',
      userPubkey: 'pub1',
      inputMint: 'So111',
      inputAmount: '1000000',
      outputMint: 'EPjFW',
      triggerMint: 'EPjFW',
      triggerCondition: 'below',
      triggerPriceUsd: 80.5,
    });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(typeof body.triggerPriceUsd).toBe('number');
    expect(body.triggerPriceUsd).toBe(80.5);
  });

  it('listOrders passes query parameters', async () => {
    mockFetchResponse({ orders: [], pagination: { total: 0, limit: 20, offset: 0 } });
    await listOrders('jwt', 'pub1', { state: 'open', limit: 10 });

    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain('userPubkey=pub1');
    expect(url).toContain('state=open');
    expect(url).toContain('limit=10');
  });

  it('updateOrder sends PATCH', async () => {
    mockFetchResponse({ success: true });
    await updateOrder('jwt', 'order-1', { orderType: 'single', triggerPriceUsd: 90 });

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/orders/order-1');
    expect(opts.method).toBe('PATCH');
  });

  it('cancelOrderRequest + confirmCancelOrder flow', async () => {
    mockFetchResponse({ id: 'order-1', transaction: 'dHhCYXNlNjQ=', requestId: 'cancel-req-1' });
    const cancelResult = await cancelOrderRequest('jwt', 'order-1');
    expect(cancelResult.requestId).toBe('cancel-req-1');

    mockFetchResponse({ id: 'order-1', txSignature: 'cancel-sig' });
    const confirmResult = await confirmCancelOrder('jwt', 'order-1', {
      signedTransaction: 'signed-cancel',
      cancelRequestId: 'cancel-req-1',
    });
    expect(confirmResult.txSignature).toBe('cancel-sig');

    const confirmUrl = global.fetch.mock.calls[1][0];
    expect(confirmUrl).toContain('/cancel/order-1/confirm');
  });

  it('throws enriched error on API failure', async () => {
    mockFetchResponse(
      { code: 'LIMIT_ORDER_AUTH_FAILED', message: 'Invalid signature' },
      401,
    );

    await expect(getVault('bad-jwt', 'pub1')).rejects.toThrow('Invalid signature');
    try {
      mockFetchResponse({ code: 'LIMIT_ORDER_AUTH_FAILED', message: 'Invalid signature' }, 401);
      await getVault('bad-jwt', 'pub1');
    } catch (err) {
      expect(err.code).toBe('LIMIT_ORDER_AUTH_FAILED');
      expect(err.status).toBe(401);
    }
  });

  it('throws on non-JSON response', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => '<html>Bad Gateway</html>',
    });

    await expect(getVault('jwt', 'pub1')).rejects.toThrow('non-JSON response');
  });

  it('converts a redirect rejection (redirect: error) into a coded, actionable error', async () => {
    // undici throws a bare TypeError('fetch failed') when redirect:'error' hits a 3xx.
    global.fetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    const err = await getVault('jwt', 'pub1').catch((e) => e);
    expect(err.code).toBe('LIMIT_ORDER_NETWORK_ERROR');
    expect(err.message).toMatch(/Limit order API request failed/);
    expect(err.message).not.toBe('fetch failed'); // not the undecorated TypeError
  });
});

// ============= Message Signing =============

describe('signSolanaMessage', () => {
  it('signs with local wallet using Ed25519', async () => {
    // Generate a test keypair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16); // Extract 32-byte seed
    const privateKeyHex = Buffer.concat([seed, publicKey.export({ type: 'spki', format: 'der' }).subarray(12)]).toString('hex');

    const message = Buffer.from('test challenge message');
    const signature = await signSolanaMessage(message, 'local', { privateKeyHex });

    expect(signature).toBeInstanceOf(Buffer);
    expect(signature.length).toBe(64); // Ed25519 signature is 64 bytes
  });

  it('signs with privy wallet', async () => {
    const mockPrivyClient = {
      signSolanaMessage: vi.fn().mockResolvedValue({
        data: { signature: Buffer.from('fake-sig-64-bytes-padding-here-000000000000000000000000000000').toString('base64') },
      }),
    };

    const message = Buffer.from('test challenge');
    const signature = await signSolanaMessage(message, 'privy', {
      privyClient: mockPrivyClient,
      walletId: 'wallet-123',
    });

    expect(mockPrivyClient.signSolanaMessage).toHaveBeenCalledWith('wallet-123', message);
    expect(signature).toBeInstanceOf(Buffer);
  });

  it('throws for unsupported wallet type', async () => {
    await expect(signSolanaMessage(Buffer.from('test'), 'unknown', {}))
      .rejects.toThrow('Unsupported wallet type');
  });
});

// ============= Authentication Flow =============

describe('authenticate', () => {
  it('returns cached token when valid', async () => {
    saveCachedToken('pub1', 'cached-jwt');
    const token = await authenticate('pub1', 'local', {});
    expect(token).toBe('cached-jwt');
    expect(global.fetch).not.toHaveBeenCalled(); // No API call needed
  });

  it('performs challenge-response when no cache', async () => {
    // Generate test keypair for signing
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16);
    const privateKeyHex = Buffer.concat([seed, publicKey.export({ type: 'spki', format: 'der' }).subarray(12)]).toString('hex');

    // Mock challenge and verify endpoints
    mockFetchSequence([
      { body: { challenge: 'sign this' } },
      { body: { token: 'new-jwt-token' } },
    ]);

    const token = await authenticate('pub1', 'local', { privateKeyHex });
    expect(token).toBe('new-jwt-token');

    // Should have called challenge and verify
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const challengeUrl = global.fetch.mock.calls[0][0];
    const verifyUrl = global.fetch.mock.calls[1][0];
    expect(challengeUrl).toContain('/auth/challenge');
    expect(verifyUrl).toContain('/auth/verify');

    // Should have cached the token
    expect(loadCachedToken('pub1')).toBe('new-jwt-token');
  });

  it('performs challenge-response when cache expired', async () => {
    // Write an expired cache
    const cachePath = path.join(tempDir, '.nansen', 'limit-order-auth.json');
    const dir = path.dirname(cachePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(cachePath, JSON.stringify({
      walletPubkey: 'pub1',
      token: 'old-jwt',
      expiresAt: Date.now() - 1000,
    }));

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16);
    const privateKeyHex = Buffer.concat([seed, publicKey.export({ type: 'spki', format: 'der' }).subarray(12)]).toString('hex');

    mockFetchSequence([
      { body: { challenge: 'sign this' } },
      { body: { token: 'refreshed-jwt' } },
    ]);

    const token = await authenticate('pub1', 'local', { privateKeyHex });
    expect(token).toBe('refreshed-jwt');
  });
});

// ============= Wallet Resolution =============

describe('resolveSolanaWallet', () => {
  it('resolves local wallet by name', async () => {
    createTestWallet('my-wallet');
    const result = await resolveSolanaWallet('my-wallet', { log: () => {}, exit: () => {} });
    expect(result).not.toBeNull();
    expect(result.pubkey).toBeTruthy();
    expect(result.walletType).toBe('local');
    expect(result.walletName).toBe('my-wallet');
  });

  it('resolves default wallet when no name given', async () => {
    createTestWallet('default-test');
    const result = await resolveSolanaWallet(undefined, { log: () => {}, exit: () => {} });
    expect(result).not.toBeNull();
    expect(result.walletType).toBe('local');
  });

  it('calls exit when no wallet found', async () => {
    const exit = vi.fn();
    const logs = [];
    await resolveSolanaWallet(undefined, { log: (m) => logs.push(m), exit });
    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.some(l => l.includes('No Solana wallet found'))).toBe(true);
  });
});

// ============= Command Handlers =============

describe('buildLimitOrderCommands', () => {
  // ---- create ----
  describe('create', () => {
    it('shows help when required params missing', async () => {
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      await cmds.create([], null, {}, {});
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.some(l => l.includes('Usage:'))).toBe(true);
    });

    it('validates trigger-price is positive number', async () => {
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      await cmds.create([], null, {}, {
        from: 'SOL', to: 'USDC', amount: '1', 'trigger-mint': 'SOL', 'trigger-condition': 'below', 'trigger-price': '-5',
      });
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.some(l => l.includes('positive number'))).toBe(true);
    });

    it.each(['Infinity', '-Infinity', '1e309'])(
      'rejects non-finite trigger price %s before wallet or API activity',
      async (triggerPrice) => {
        const wallet = `lo-create-price-${triggerPrice.replace('-', 'negative-')}`;
        createTestWallet(wallet);
        const logs = [];
        const exit = vi.fn();
        const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

        await cmds.create([], null, {}, {
          from: '11111111111111111111111111111111', to: 'USDC', amount: '1', 'trigger-mint': 'SOL',
          'trigger-condition': 'below', 'trigger-price': triggerPrice, wallet,
        });

        expect(exit).toHaveBeenCalledWith(1);
        expect(logs).toContain('Error: --trigger-price must be a finite positive number.');
        expect(global.fetch).not.toHaveBeenCalled();
      },
    );

    it.each(['Infinity', '-Infinity', '1e309'])(
      'rejects non-finite expiry %s before wallet or API activity',
      async (expires) => {
        const wallet = `lo-create-expiry-${expires.replace('-', 'negative-')}`;
        createTestWallet(wallet);
        const logs = [];
        const exit = vi.fn();
        const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

        await cmds.create([], null, {}, {
          from: '11111111111111111111111111111111', to: 'USDC', amount: '1', 'trigger-mint': 'SOL',
          'trigger-condition': 'below', 'trigger-price': '80', expires, wallet,
        });

        expect(exit).toHaveBeenCalledWith(1);
        expect(logs.some(l => l.includes(`Invalid expiry "${expires}"`))).toBe(true);
        expect(global.fetch).not.toHaveBeenCalled();
      },
    );

    it('validates trigger-condition', async () => {
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      await cmds.create([], null, {}, {
        from: 'SOL', to: 'USDC', amount: '1', 'trigger-mint': 'SOL',
        'trigger-price': '80', 'trigger-condition': 'invalid',
      });
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.some(l => l.includes('"above" or "below"'))).toBe(true);
    });

    it('validates slippage-bps range', async () => {
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      await cmds.create([], null, {}, {
        from: 'SOL', to: 'USDC', amount: '1', 'trigger-mint': 'SOL',
        'trigger-price': '80', 'trigger-condition': 'below', 'slippage-bps': '15000',
      });
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.some(l => l.includes('0 and 10000'))).toBe(true);
    });

    it('rejects non-integer slippage-bps values (1.5, 1e2, 0x10, true)', async () => {
      for (const bad of ['1.5', '1e2', '0x10', true]) {
        const logs = [];
        const exit = vi.fn();
        const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

        await cmds.create([], null, {}, {
          from: 'SOL', to: 'USDC', amount: '1', 'trigger-mint': 'SOL',
          'trigger-price': '80', 'trigger-condition': 'below', 'slippage-bps': bad,
        });
        expect(exit).toHaveBeenCalledWith(1);
        expect(logs.some(l => l.includes('whole integer') && l.includes('0 and 10000'))).toBe(true);
      }
    });

    it('accepts valid slippage-bps and forwards it to createOrder', async () => {
      createTestWallet('lo-create-slip');
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      mockFetchSequence([
        { body: { challenge: 'sign this' } },
        { body: { token: 'jwt-123' } },
        { body: { vaultPubkey: 'vault123', userPubkey: 'pub1' } },
        { body: { transaction: buildFakeBase64Tx(), requestId: 'dep-req-1' } },
        { body: { id: 'order-slip', txSignature: 'sig-slip' }, status: 201 },
      ]);

      await cmds.create([], null, {}, {
        from: 'SOL', to: 'USDC', amount: '1', 'trigger-mint': 'SOL',
        'trigger-condition': 'below', 'trigger-price': '80',
        'slippage-bps': '100', wallet: 'lo-create-slip',
      });

      expect(exit).not.toHaveBeenCalled();
      expect(logs.some(l => l.includes('Limit order created'))).toBe(true);
      const createBody = JSON.parse(global.fetch.mock.calls[4][1].body);
      expect(createBody.slippageBps).toBe(100);
    });

    it('rejects EVM token address for --from', async () => {
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      await cmds.create([], null, {}, {
        from: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        to: 'USDC', amount: '1', 'trigger-mint': 'SOL', 'trigger-condition': 'below', 'trigger-price': '80',
      });
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.some(l => l.includes('Invalid --from token address'))).toBe(true);
    });

    it('rejects EVM token address for --to', async () => {
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      await cmds.create([], null, {}, {
        from: 'SOL',
        to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        amount: '1', 'trigger-mint': 'SOL', 'trigger-condition': 'below', 'trigger-price': '80',
      });
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.some(l => l.includes('Invalid --to token address'))).toBe(true);
    });

    it('accepts valid Solana mint address', async () => {
      createTestWallet('lo-addr-test');
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      mockFetchSequence([
        { body: { challenge: 'sign this' } },
        { body: { token: 'jwt-123' } },
        { body: { vaultPubkey: 'vault1', userPubkey: 'pub1' } },
        { body: { transaction: buildFakeBase64Tx(), requestId: 'dep-1' } },
        { body: { id: 'order-1', txSignature: 'sig-1' }, status: 201 },
      ]);

      // Use raw Solana mint addresses directly
      await cmds.create([], null, {}, {
        from: 'So11111111111111111111111111111111111111112',
        to: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        amount: '1', 'trigger-mint': 'SOL', 'trigger-condition': 'below', 'trigger-price': '80',
        wallet: 'lo-addr-test',
      });
      expect(exit).not.toHaveBeenCalled();
      expect(logs.some(l => l.includes('Limit order created'))).toBe(true);
    });

    it('rejects non-positive amount', async () => {
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      await cmds.create([], null, {}, {
        from: 'SOL', to: 'USDC', amount: '-5', 'trigger-mint': 'SOL', 'trigger-condition': 'below', 'trigger-price': '80',
      });
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.some(l => l.includes('positive number'))).toBe(true);
    });

    // --- Amount parsing: human-readable → base units ---

    /**
     * Helper: run a full create flow and extract the inputAmount from the API request body.
     *
     * This exercises the real amount parsing code path end-to-end:
     *   user input (e.g. "0.5") → parseAmount() → base units string → sent to createOrder API
     *
     * We mock the 5 sequential API calls that the create flow makes:
     *   [0] POST /auth/challenge   — returns a challenge string
     *   [1] POST /auth/verify      — returns a JWT token
     *   [2] GET  /vault            — returns vault info (already registered)
     *   [3] POST /deposit/craft    — returns an unsigned deposit transaction
     *   [4] POST /create           — creates the order ← we inspect this call's body
     *
     * The mock responses are minimal stubs — only enough to not error.
     * We then read global.fetch.mock.calls[4] (the 5th call = createOrder)
     * and parse its JSON body to get the inputAmount that was actually sent.
     *
     * ⚠️  If the API call sequence changes (e.g. a new call is added before
     * createOrder), update the index [4] and the mockFetchSequence array.
     */
    async function createAndGetInputAmount(amountStr, fromToken = 'SOL') {
      const walletName = `lo-amt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      createTestWallet(walletName);
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      const CREATE_ORDER_CALL_INDEX = 4;
      mockFetchSequence([
        { body: { challenge: 'sign this' } },          // [0] auth/challenge
        { body: { token: 'jwt-123' } },                 // [1] auth/verify
        { body: { vaultPubkey: 'vault1', userPubkey: 'pub1' } }, // [2] vault check
        { body: { transaction: buildFakeBase64Tx(), requestId: 'dep-1' } }, // [3] deposit/craft
        { body: { id: 'order-1', txSignature: 'sig-1' }, status: 201 },    // [4] createOrder
      ]);

      await cmds.create([], null, {}, {
        from: fromToken, to: 'USDC', amount: amountStr,
        'trigger-mint': 'SOL', 'trigger-condition': 'below', 'trigger-price': '80',
        wallet: walletName,
      });

      if (exit.mock.calls.length > 0) {
        throw new Error(`create exited with code ${exit.mock.calls[0][0]}. Logs: ${logs.join(' | ')}`);
      }

      // Extract the inputAmount from the createOrder API request body
      const createCall = global.fetch.mock.calls[CREATE_ORDER_CALL_INDEX];
      const createBody = JSON.parse(createCall[1].body);
      return createBody.inputAmount;
    }

    it('converts 1 SOL to 1000000000 base units', async () => {
      expect(await createAndGetInputAmount('1', 'SOL')).toBe('1000000000');
    });

    it('converts 0.5 SOL to 500000000 base units', async () => {
      expect(await createAndGetInputAmount('0.5', 'SOL')).toBe('500000000');
    });

    it('converts 0.000000001 SOL (1 lamport) correctly', async () => {
      expect(await createAndGetInputAmount('0.000000001', 'SOL')).toBe('1');
    });

    it('converts 100 USDC to 100000000 base units (6 decimals)', async () => {
      expect(await createAndGetInputAmount('100', 'USDC')).toBe('100000000');
    });

    it('converts 0.01 USDC to 10000 base units', async () => {
      expect(await createAndGetInputAmount('0.01', 'USDC')).toBe('10000');
    });

    it('converts 1.5 SOL to 1500000000 base units', async () => {
      expect(await createAndGetInputAmount('1.5', 'SOL')).toBe('1500000000');
    });

    it('converts 0.123456789 SOL without floating point error', async () => {
      // 0.123456789 * 1e9 = 123456789 — must not produce 123456788 or 123456790
      expect(await createAndGetInputAmount('0.123456789', 'SOL')).toBe('123456789');
    });

    it('converts 0.1 SOL without floating point error (0.1 is inexact in IEEE 754)', async () => {
      expect(await createAndGetInputAmount('0.1', 'SOL')).toBe('100000000');
    });

    it('converts 0.3 USDC without floating point error', async () => {
      // 0.1 + 0.2 != 0.3 in JS, but string parsing should be exact
      expect(await createAndGetInputAmount('0.3', 'USDC')).toBe('300000');
    });

    it('truncates excess decimals beyond token precision (SOL: 9)', async () => {
      // 0.0000000019 has 10 decimal places; should truncate to 1 lamport
      expect(await createAndGetInputAmount('0.0000000019', 'SOL')).toBe('1');
    });

    it('truncates excess decimals beyond token precision (USDC: 6)', async () => {
      // 0.0000019 has 7 decimal places; should truncate to 1
      expect(await createAndGetInputAmount('0.0000019', 'USDC')).toBe('1');
    });

    it('handles whole number without decimal for SOL', async () => {
      expect(await createAndGetInputAmount('10', 'SOL')).toBe('10000000000');
    });

    it('handles large amount (1000 SOL)', async () => {
      expect(await createAndGetInputAmount('1000', 'SOL')).toBe('1000000000000');
    });

    it('rejects zero amount', async () => {
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });
      await cmds.create([], null, {}, {
        from: 'SOL', to: 'USDC', amount: '0',
        'trigger-mint': 'SOL', 'trigger-condition': 'below', 'trigger-price': '80',
      });
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('rejects non-numeric amount', async () => {
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });
      await cmds.create([], null, {}, {
        from: 'SOL', to: 'USDC', amount: 'abc',
        'trigger-mint': 'SOL', 'trigger-condition': 'below', 'trigger-price': '80',
      });
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('executes full create flow with local wallet', async () => {
      createTestWallet('lo-create-test');

      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      // Mock the full API call sequence:
      // 1. challenge, 2. verify, 3. getVault, 4. craftDeposit, 5. createOrder
      mockFetchSequence([
        { body: { challenge: 'sign this' } },
        { body: { token: 'jwt-123' } },
        { body: { vaultPubkey: 'vault123', userPubkey: 'pub1' } },
        { body: { transaction: buildFakeBase64Tx(), requestId: 'dep-req-1' } },
        { body: { id: 'order-abc', txSignature: 'sig-xyz' }, status: 201 },
      ]);

      await cmds.create([], null, {}, {
        from: 'SOL',
        to: 'USDC',
        amount: '1',
        'trigger-mint': 'SOL',
        'trigger-condition': 'below',
        'trigger-price': '80',
        wallet: 'lo-create-test',
      });

      expect(exit).not.toHaveBeenCalled();
      expect(logs.some(l => l.includes('order-abc'))).toBe(true);
      expect(logs.some(l => l.includes('sig-xyz'))).toBe(true);
      expect(logs.some(l => l.includes('Limit order created'))).toBe(true);

      // Verify createOrder was called with Number for triggerPriceUsd
      const createCall = global.fetch.mock.calls[4];
      const createBody = JSON.parse(createCall[1].body);
      expect(typeof createBody.triggerPriceUsd).toBe('number');
      expect(createBody.triggerPriceUsd).toBe(80);
      expect(createBody.orderType).toBe('single');
    });

    it('auto-registers vault when not found', async () => {
      createTestWallet('lo-vault-test');

      const logs = [];
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit: vi.fn() });

      // vault returns null → triggers register
      mockFetchSequence([
        { body: { challenge: 'sign this' } },
        { body: { token: 'jwt-123' } },
        { body: { message: 'Vault not found' }, status: 404 }, // getVault returns no vault
        { body: { vaultPubkey: 'newVault', userPubkey: 'pub1' }, status: 201 }, // registerVault
        { body: { transaction: buildFakeBase64Tx(), requestId: 'dep-1' } },
        { body: { id: 'order-1', txSignature: 'sig-1' }, status: 201 },
      ]);

      await cmds.create([], null, {}, {
        from: 'SOL', to: 'USDC', amount: '1', 'trigger-mint': 'SOL', 'trigger-condition': 'below', 'trigger-price': '80',
        wallet: 'lo-vault-test',
      });

      expect(logs.some(l => l.includes('Registering vault'))).toBe(true);
      // Should have made 6 API calls (challenge, verify, getVault, registerVault, craftDeposit, createOrder)
      expect(global.fetch).toHaveBeenCalledTimes(6);
    });
  });

  // ---- list ----
  describe('list', () => {
    it('shows "no orders" when empty', async () => {
      createTestWallet('lo-list-test');
      const logs = [];
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit: vi.fn() });

      mockFetchSequence([
        { body: { challenge: 'sign' } },
        { body: { token: 'jwt' } },
        { body: { orders: [], pagination: { total: 0, limit: 20, offset: 0 } } },
      ]);

      await cmds.list([], null, {}, { wallet: 'lo-list-test' });
      expect(logs.some(l => l.includes('No limit orders found'))).toBe(true);
    });

    it('formats and displays orders', async () => {
      createTestWallet('lo-list-fmt');
      const logs = [];
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit: vi.fn() });

      mockFetchSequence([
        { body: { challenge: 'sign' } },
        { body: { token: 'jwt' } },
        {
          body: {
            orders: [{
              id: 'order-999',
              status: 'open',
              inputMint: 'So11111111111111111111111111111111111111112',
              outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              inputAmount: '1000000000',
              triggerPriceUsd: 80.5,
              triggerMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              triggerCondition: 'below',
              createdAt: '2026-03-20T00:00:00Z',
              fills: [],
            }],
            pagination: { total: 1, limit: 20, offset: 0 },
          },
        },
      ]);

      await cmds.list([], null, {}, { wallet: 'lo-list-fmt' });
      expect(logs.some(l => l.includes('order-999'))).toBe(true);
      expect(logs.some(l => l.includes('Open'))).toBe(true);
      expect(logs.some(l => l.includes('$80.5'))).toBe(true);
    });

    it('renders the list even when an order has a non-integer amount (M8)', async () => {
      createTestWallet('lo-list-bad-amount');
      const logs = [];
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit: vi.fn() });

      mockFetchSequence([
        { body: { challenge: 'sign' } },
        { body: { token: 'jwt' } },
        {
          body: {
            orders: [{
              id: 'order-bad',
              status: 'open',
              inputMint: 'So11111111111111111111111111111111111111112',
              outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              inputAmount: '1.5e9', // float/scientific — BigInt() would throw
              triggerPriceUsd: 80.5,
              triggerMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              triggerCondition: 'below',
              createdAt: '2026-03-20T00:00:00Z',
              fills: [],
            }],
            pagination: { total: 1, limit: 20, offset: 0 },
          },
        },
      ]);

      await expect(
        cmds.list([], null, {}, { wallet: 'lo-list-bad-amount' }),
      ).resolves.not.toThrow();
      expect(logs.some(l => l.includes('order-bad'))).toBe(true);
    });

    it('passes filter and pagination params', async () => {
      createTestWallet('lo-list-filter');
      const cmds = buildLimitOrderCommands({ log: () => {}, exit: vi.fn() });

      mockFetchSequence([
        { body: { challenge: 'sign' } },
        { body: { token: 'jwt' } },
        { body: { orders: [], pagination: { total: 0, limit: 5, offset: 10 } } },
      ]);

      await cmds.list([], null, {}, {
        wallet: 'lo-list-filter', state: 'filled', limit: 5, offset: 10,
      });

      const ordersUrl = global.fetch.mock.calls[2][0];
      expect(ordersUrl).toContain('state=filled');
      expect(ordersUrl).toContain('limit=5');
      expect(ordersUrl).toContain('offset=10');
    });
  });

  // ---- cancel ----
  describe('cancel', () => {
    it('shows help when order ID missing', async () => {
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      await cmds.cancel([], null, {}, {});
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.some(l => l.includes('Usage:'))).toBe(true);
    });

    it('executes full cancel flow', async () => {
      createTestWallet('lo-cancel-test');
      const logs = [];
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit: vi.fn() });

      // challenge, verify, cancelRequest, confirmCancel
      mockFetchSequence([
        { body: { challenge: 'sign' } },
        { body: { token: 'jwt' } },
        { body: { id: 'order-1', transaction: buildFakeBase64Tx(), requestId: 'cancel-req-1' } },
        { body: { id: 'order-1', txSignature: 'cancel-sig-abc' } },
      ]);

      await cmds.cancel([], null, {}, { order: 'order-1', wallet: 'lo-cancel-test' });

      expect(logs.some(l => l.includes('Order cancelled'))).toBe(true);
      expect(logs.some(l => l.includes('cancel-sig-abc'))).toBe(true);
    });
  });

  // ---- update ----
  describe('update', () => {
    it('shows help when order ID missing', async () => {
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      await cmds.update([], null, {}, {});
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.some(l => l.includes('Usage:'))).toBe(true);
    });

    it('errors when no update fields provided', async () => {
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      await cmds.update([], null, {}, { order: 'order-1' });
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.some(l => l.includes('at least one'))).toBe(true);
    });

    it('updates trigger price', async () => {
      createTestWallet('lo-update-test');
      const logs = [];
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit: vi.fn() });

      mockFetchSequence([
        { body: { challenge: 'sign' } },
        { body: { token: 'jwt' } },
        { body: { success: true } },
      ]);

      await cmds.update([], null, {}, {
        order: 'order-1', 'trigger-price': '85', wallet: 'lo-update-test',
      });

      expect(logs.some(l => l.includes('Order updated'))).toBe(true);
      expect(logs.some(l => l.includes('$85'))).toBe(true);

      const patchBody = JSON.parse(global.fetch.mock.calls[2][1].body);
      expect(patchBody.triggerPriceUsd).toBe(85);
      expect(patchBody.orderType).toBe('single');
    });

    it.each(['Infinity', '-Infinity', '1e309'])(
      'rejects non-finite trigger price %s before wallet or API activity',
      async (triggerPrice) => {
        const wallet = `lo-update-price-${triggerPrice.replace('-', 'negative-')}`;
        createTestWallet(wallet);
        const logs = [];
        const exit = vi.fn();
        const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

        await cmds.update([], null, {}, {
          order: 'order-1', 'trigger-price': triggerPrice, wallet,
        });

        expect(exit).toHaveBeenCalledWith(1);
        expect(logs).toContain('Error: --trigger-price must be a finite positive number.');
        expect(global.fetch).not.toHaveBeenCalled();
      },
    );

    it('updates slippage', async () => {
      createTestWallet('lo-update-slip');
      const logs = [];
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit: vi.fn() });

      mockFetchSequence([
        { body: { challenge: 'sign' } },
        { body: { token: 'jwt' } },
        { body: { success: true } },
      ]);

      await cmds.update([], null, {}, {
        order: 'order-1', 'slippage-bps': '100', wallet: 'lo-update-slip',
      });

      const patchBody = JSON.parse(global.fetch.mock.calls[2][1].body);
      expect(patchBody.slippageBps).toBe(100);
      expect(patchBody.triggerPriceUsd).toBeUndefined();
    });

    it('validates slippage range', async () => {
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      await cmds.update([], null, {}, { order: 'order-1', 'slippage-bps': '15000' });
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.some(l => l.includes('0 and 10000'))).toBe(true);
    });

    it('rejects non-integer slippage-bps on update', async () => {
      const logs = [];
      const exit = vi.fn();
      const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

      await cmds.update([], null, {}, { order: 'order-1', 'slippage-bps': '1.5' });
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.some(l => l.includes('whole integer') && l.includes('0 and 10000'))).toBe(true);
    });
  });
});

// ============= Outcome verification (fail-closed) =============
//
// These exercise the create/cancel handlers with a real (non-null) simulation
// RPC configured, proving a simulated drain refuses to sign rather than
// proceeding. The handlers never throw (each wraps its body in try/catch and
// calls exit(1)), so the observable signal is: exit(1), a "Refusing to sign"
// log line, and the fact that the downstream submit endpoint (createOrder /
// confirmCancelOrder) was never reached — asserted via the mocked fetch call
// count, since a module-local signTransaction spy can't intercept the
// handler's internal call.
describe('outcome verification (fail-closed)', () => {
  it('create: refuses to sign a deposit whose simulated outflow exceeds the requested amount (repro)', async () => {
    SIMULATION_RPCS.solana = 'http://sol-sim.test';
    const wallet = createTestWallet('lo-outcome-deposit-drain');
    const depositTx = buildLimitOrderTx({ walletPubkey: wallet.solana });

    mockFetchSequence([
      { body: { challenge: 'sign this' } },
      { body: { token: 'jwt-123' } },
      { body: { vaultPubkey: 'vault123', userPubkey: 'pub1' } },
      { body: { transaction: depositTx, requestId: 'dep-req-1' } },
      // sim: getMultipleAccounts — pre-state for the wallet's native account.
      { body: { result: { value: [solanaNativeAccountInfo(2_000_000_000)] } } },
      // sim: simulateTransaction — post-state shows a 1.123456789 SOL outflow,
      // not the requested 1 SOL (the reproduced SystemProgram-transfer drain).
      { body: { result: { value: { err: null, accounts: [solanaNativeAccountInfo(2_000_000_000 - 1_123_456_789)] } } } },
    ]);

    const logs = [];
    const exit = vi.fn();
    const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

    await cmds.create([], null, {}, {
      from: 'SOL', to: 'USDC', amount: '1',
      'trigger-mint': 'SOL', 'trigger-condition': 'below', 'trigger-price': '80',
      wallet: 'lo-outcome-deposit-drain',
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.some(l => /Refusing to sign deposit/i.test(l))).toBe(true);
    expect(logs.some(l => /LIMIT_ORDER_OUTCOME_MISMATCH/i.test(l))).toBe(true);
    // 6 calls: challenge, verify, getVault, craftDeposit, getMultipleAccounts,
    // simulateTransaction — createOrder (the 7th) must never fire.
    expect(global.fetch).toHaveBeenCalledTimes(6);
  });

  it('cancel: refuses to sign a withdrawal that drains an SPL token from the wallet', async () => {
    SIMULATION_RPCS.solana = 'http://sol-sim.test';
    const wallet = createTestWallet('lo-outcome-cancel-drain');
    const siblingMint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    const siblingTokenAccount = generateSolanaWallet().address;
    const cancelTx = buildLimitOrderTx({ walletPubkey: wallet.solana, extraWritableKey: siblingTokenAccount });

    mockFetchSequence([
      { body: { challenge: 'sign' } },
      { body: { token: 'jwt' } },
      { body: { id: 'order-1', transaction: cancelTx, requestId: 'cancel-req-1' } },
      // sim: getMultipleAccounts — pre-state: wallet native + a token account
      // the wallet owns, holding 1,000,000 base units.
      {
        body: {
          result: {
            value: [
              solanaNativeAccountInfo(2_000_000_000),
              solanaTokenAccountInfo({ mint: siblingMint, owner: wallet.solana, amount: 1_000_000 }),
            ],
          },
        },
      },
      // sim: simulateTransaction — wallet's native balance only drops by a
      // fee (well within dust), but the token account is fully drained: a
      // cancel should only ever return funds TO the wallet.
      {
        body: {
          result: {
            value: {
              err: null,
              accounts: [
                solanaNativeAccountInfo(2_000_000_000 - 5000),
                solanaTokenAccountInfo({ mint: siblingMint, owner: wallet.solana, amount: 0 }),
              ],
            },
          },
        },
      },
    ]);

    const logs = [];
    const exit = vi.fn();
    const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

    await cmds.cancel([], null, {}, { order: 'order-1', wallet: 'lo-outcome-cancel-drain' });

    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.some(l => /Refusing to sign withdrawal/i.test(l))).toBe(true);
    expect(logs.some(l => /LIMIT_ORDER_OUTCOME_MISMATCH/i.test(l))).toBe(true);
    // 5 calls: challenge, verify, cancelRequest, getMultipleAccounts,
    // simulateTransaction — confirmCancelOrder (the 6th) must never fire.
    expect(global.fetch).toHaveBeenCalledTimes(5);
  });

  it('create: proceeds (graceful degrade) when the simulation RPC errors out mid-flight', async () => {
    SIMULATION_RPCS.solana = 'http://sol-sim.test';
    const wallet = createTestWallet('lo-outcome-degrade');
    const depositTx = buildLimitOrderTx({ walletPubkey: wallet.solana });

    mockFetchSequence([
      { body: { challenge: 'sign this' } },
      { body: { token: 'jwt-123' } },
      { body: { vaultPubkey: 'vault123', userPubkey: 'pub1' } },
      { body: { transaction: depositTx, requestId: 'dep-req-1' } },
      // sim: getMultipleAccounts fails outright (transport/RPC error) — must
      // degrade (warn + proceed), not block a legitimate deposit.
      { body: { error: { message: 'rate limited' } }, status: 200 },
      { body: { id: 'order-1', txSignature: 'sig-1' }, status: 201 },
    ]);

    const logs = [];
    const exit = vi.fn();
    const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

    await cmds.create([], null, {}, {
      from: 'SOL', to: 'USDC', amount: '1',
      'trigger-mint': 'SOL', 'trigger-condition': 'below', 'trigger-price': '80',
      wallet: 'lo-outcome-degrade',
    });

    expect(exit).not.toHaveBeenCalled();
    expect(logs.some(l => /could not run.*proceeding without/i.test(l))).toBe(true);
    expect(logs.some(l => l.includes('Limit order created'))).toBe(true);
  });

  it('cancel: proceeds (graceful degrade) when the simulation RPC errors out mid-flight', async () => {
    SIMULATION_RPCS.solana = 'http://sol-sim.test';
    const wallet = createTestWallet('lo-outcome-cancel-degrade');
    const cancelTx = buildLimitOrderTx({ walletPubkey: wallet.solana });

    mockFetchSequence([
      { body: { challenge: 'sign' } },
      { body: { token: 'jwt' } },
      { body: { id: 'order-1', transaction: cancelTx, requestId: 'cancel-req-1' } },
      // sim: getMultipleAccounts fails outright (transport/RPC error) — must
      // degrade (warn + proceed), not block a legitimate cancellation.
      { body: { error: { message: 'rate limited' } }, status: 200 },
      { body: { id: 'order-1', txSignature: 'cancel-sig-abc' } },
    ]);

    const logs = [];
    const exit = vi.fn();
    const cmds = buildLimitOrderCommands({ log: (m) => logs.push(m), exit });

    await cmds.cancel([], null, {}, { order: 'order-1', wallet: 'lo-outcome-cancel-degrade' });

    expect(exit).not.toHaveBeenCalled();
    expect(logs.some(l => /could not run.*proceeding without/i.test(l))).toBe(true);
    expect(logs.some(l => l.includes('Order cancelled'))).toBe(true);
  });
});

// ============= Helpers =============

/**
 * Build a minimal parseable legacy Solana transaction whose first account key
 * is the real wallet pubkey (writable, the only required signer) so
 * simulateSolanaAssetChanges can locate and track it. `extraWritableKey`, when
 * given, is a second writable non-signer account (used to simulate a token
 * account the wallet owns). Zero instructions — the outcome tests only care
 * about the mocked pre/post account snapshots, not the instruction contents.
 */
function buildLimitOrderTx({ walletPubkey, extraWritableKey } = {}) {
  const keys = extraWritableKey ? [walletPubkey, extraWritableKey] : [walletPubkey];
  const header = Buffer.from([1, 0, 0]); // 1 required signer (wallet), 0 readonly signed, 0 readonly unsigned
  const numKeys = Buffer.from([keys.length]);
  const keyBytes = Buffer.concat(keys.map((k) => base58Decode(k)));
  const blockhash = Buffer.alloc(32, 0x03);
  const numInstructions = Buffer.from([0x00]);
  const message = Buffer.concat([header, numKeys, keyBytes, blockhash, numInstructions]);
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64');
}

/** Native-SOL account info shape expected from a getMultipleAccounts/simulateTransaction response. */
function solanaNativeAccountInfo(lamports) {
  return { lamports, owner: '11111111111111111111111111111111', data: ['', 'base64'], executable: false, rentEpoch: 0 };
}

/** jsonParsed SPL-token account info shape. */
function solanaTokenAccountInfo({ mint, owner, amount }) {
  return {
    lamports: 2039280,
    owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    data: { program: 'spl-token', parsed: { type: 'account', info: { mint, owner, tokenAmount: { amount: String(amount), decimals: 6 } } } },
    executable: false,
    rentEpoch: 0,
  };
}

/**
 * Build a minimal valid base64-encoded Solana VersionedTransaction.
 * This is a simplified fake for testing — just needs to be parseable
 * by signSolanaTransaction (compact-u16 sig count + 64-byte sig slot + message).
 */
function buildFakeBase64Tx() {
  // A valid, parseable legacy transaction with a single benign instruction:
  // 1 signature slot, then a legacy message [header][2 account keys][blockhash]
  // [1 instruction referencing a non-SPL program]. It must actually parse —
  // assertSolanaInstructionsSafe (run before signing on this path) now rejects
  // unparseable transactions rather than silently ignoring them.
  const sigCount = Buffer.from([0x01]);
  const emptySig = Buffer.alloc(64, 0);
  const header = Buffer.from([1, 0, 1]); // 1 signer (writable), 1 readonly unsigned (the program)
  const numKeys = Buffer.from([0x02]);
  const signerKey = Buffer.alloc(32, 0x01); // account index 0 = signer / fee payer
  const programKey = Buffer.alloc(32, 0x02); // account index 1 = an arbitrary (non-SPL) program
  const blockhash = Buffer.alloc(32, 0x03);
  const numInstructions = Buffer.from([0x01]);
  // instruction: programIdIndex=1, 1 account (index 0), 1 data byte
  const instruction = Buffer.from([0x01, 0x01, 0x00, 0x01, 0x00]);
  const message = Buffer.concat([header, numKeys, signerKey, programKey, blockhash, numInstructions, instruction]);
  return Buffer.concat([sigCount, emptySig, message]).toString('base64');
}
