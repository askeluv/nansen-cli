import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../wallet.js', () => ({
  showWallet: vi.fn(() => ({ name: 'w', evm: '0x' + 'a'.repeat(40), provider: 'local' })),
  getWalletConfig: vi.fn(() => ({ defaultWallet: 'w' })),
  exportWallet: vi.fn(() => ({ evm: { privateKey: '11'.repeat(32) } })),
}));

vi.mock('../keychain.js', () => ({
  retrievePassword: vi.fn(() => ({ password: 'pw', source: 'keychain' })),
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildBridgeCommands } from '../bridge.js';
import { buildPerpCommands, screenOrThrow } from '../perp.js';

const WALLET = '0x8CB9c3F23C7d600fB430bbd171a313D9ea61cEBc';

let tmpHome;
let prevHome;

// Records the per-request options each call passed, which is the whole point:
// these are money-moving paths where a cached response or an automatic re-send
// is a correctness problem rather than an optimisation.
function recordingApi(respond = () => ({})) {
  const calls = [];
  return {
    calls,
    optionsFor: (match) => calls.find(c => c.endpoint.includes(match))?.options,
    request: async (endpoint, body, options = {}) => {
      calls.push({ endpoint, body, options });
      return respond(endpoint, body);
    },
  };
}

beforeEach(() => {
  prevHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-reqopts-'));
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.nansen', 'quotes'), { recursive: true });
});

afterEach(() => {
  process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('compliance screening is never served from cache', () => {
  it('passes cache: false on the screen call', async () => {
    const api = recordingApi(() => ({ results: [{ address: WALLET, sanctioned: false }] }));
    await screenOrThrow(api, [WALLET]);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].endpoint).toContain('/api/v1/sanctions/screen');
    expect(api.calls[0].options.cache).toBe(false);
  });
});

describe('bridge request options', () => {
  it('reads status with cache: false so polling can observe progress', async () => {
    const api = recordingApi(() => ({ status: 'pending' }));
    await buildBridgeCommands({ log: () => {} }).status([], api, {}, { 'request-id': 'req-1' });
    const opts = api.optionsFor('/perp/bridge/status');
    expect(opts.cache).toBe(false);
  });

  it('quotes with cache: false', async () => {
    const api = recordingApi(() => ({ details: {}, fees: {}, steps: [] }));
    await buildBridgeCommands({ log: () => {} }).quote([], api, {}, {
      'from-chain': 'base', 'to-chain': 'hyperliquid',
      'from-token': 'USDC', amount: '5000000', wallet: 'w',
    });
    expect(api.optionsFor('/perp/bridge/quote').cache).toBe(false);
  });

  // Relay's /authorize and HL's /exchange are not idempotent, so an automatic
  // retry on a 500/502 can submit the same signed action twice.
  it('posts execute with retry: false', async () => {
    const quotesDir = path.join(tmpHome, '.nansen', 'quotes');
    fs.writeFileSync(path.join(quotesDir, 'bridge-r1.json'), JSON.stringify({
      quoteId: 'bridge-r1',
      type: 'bridge',
      originChain: 'hyperliquid',
      destinationChain: 'base',
      walletProvider: 'local',
      walletAddress: WALLET,
      timestamp: Date.now(),
      response: {
        execution_type: 'hyperliquid_signature',
        request_id: 'req-r1',
        steps: [{
          id: 'authorize',
          items: [{
            data: {
              sign: {
                domain: {
                  name: 'Relay', version: '1', chainId: 1,
                  verifyingContract: '0x' + '0'.repeat(40),
                },
                types: { Authorize: [{ name: 'nonce', type: 'uint256' }] },
                primaryType: 'Authorize',
                value: { nonce: '1' },
              },
              post: { endpoint: '/authorize', body: {} },
            },
          }],
        }],
      },
    }));

    const api = recordingApi((endpoint) => {
      if (endpoint.includes('/sanctions/screen')) {
        return { results: [{ address: WALLET, sanctioned: false }] };
      }
      if (endpoint.includes('/bridge/status')) return { status: 'success' };
      return { ok: true };
    });

    const { showWallet } = await import('../wallet.js');
    showWallet.mockReturnValue({ name: 'w', evm: WALLET, provider: 'local' });

    await buildBridgeCommands({ log: () => {} }).execute([], api, {}, { quote: 'bridge-r1' });

    const opts = api.optionsFor('/perp/bridge/execute');
    expect(opts).toBeDefined();
    expect(opts.retry).toBe(false);
    expect(opts.cache).toBe(false);
  });
});

describe('perp reads bypass the cache', () => {
  // close sizes its order from the positions read, and asset ids come from meta,
  // so a stale hit would be signed against.
  for (const [sub, endpoint] of [
    ['positions', '/perp/positions'],
    ['orders', '/perp/orders'],
    ['account', '/perp/account'],
    ['meta', '/perp/meta'],
  ]) {
    it(`${sub} passes cache: false`, async () => {
      const api = recordingApi(() => ({ data: [] }));
      await buildPerpCommands({ log: () => {} })[sub]([], api, {}, { wallet: 'w' });
      const opts = api.optionsFor(endpoint);
      expect(opts).toBeDefined();
      expect(opts.cache).toBe(false);
    });
  }
});
