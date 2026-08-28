import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../wallet.js', () => ({
  showWallet: vi.fn(),
  getWalletConfig: vi.fn(() => ({ defaultWallet: 'w' })),
  exportWallet: vi.fn(() => ({ evm: { privateKey: '11'.repeat(32) } })),
}));

vi.mock('../keychain.js', () => ({
  retrievePassword: vi.fn(() => ({ password: 'pw', source: 'keychain' })),
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { showWallet } from '../wallet.js';
import { buildBridgeCommands } from '../bridge.js';
import { hashTypedData } from '../x402-evm.js';

const WALLET = '0x8CB9c3F23C7d600fB430bbd171a313D9ea61cEBc';

let tmpHome;
let prevHome;
let quotesDir;

beforeEach(() => {
  prevHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-eip712-'));
  process.env.HOME = tmpHome;
  quotesDir = path.join(tmpHome, '.nansen', 'quotes');
  fs.mkdirSync(quotesDir, { recursive: true });
  showWallet.mockReturnValue({ name: 'w', evm: WALLET, provider: 'local' });
});

afterEach(() => {
  process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// An empty field list is not a signing error at the hashing layer — it produces
// a perfectly well-formed digest over none of the message's contents. So the
// refusal has to live above it.
describe('hashTypedData with no fields', () => {
  it('still returns a hash, which is why the caller must guard', () => {
    const hash = hashTypedData(
      { name: 'HyperliquidSignTransaction', version: '1', chainId: 1, verifyingContract: '0x' + '0'.repeat(40) },
      'HyperliquidTransaction',
      [],
      {},
    );
    expect(hash).toBeDefined();
    expect(hash.length).toBe(32);
  });
});

function writeQuote(quoteId, step) {
  fs.writeFileSync(path.join(quotesDir, `${quoteId}.json`), JSON.stringify({
    quoteId,
    type: 'bridge',
    originChain: 'hyperliquid',
    destinationChain: 'base',
    walletProvider: 'local',
    walletAddress: WALLET,
    requestedAmountBaseUnits: '500000000',
    timestamp: Date.now(),
    response: {
      execution_type: 'hyperliquid_signature',
      request_id: 'req-1',
      details: { currencyIn: { amount: '500000000', amountFormatted: '5.0' } },
      steps: [step],
    },
  }));
}

function api() {
  return {
    request: async (endpoint, body) => {
      if (endpoint.includes('/sanctions/screen')) {
        return { results: (body?.addresses || []).map(address => ({ address, sanctioned: false })) };
      }
      if (endpoint.includes('/bridge/status')) return { status: 'success' };
      return { ok: true };
    },
  };
}

const execute = (quoteId) =>
  buildBridgeCommands({ log: () => {} }).execute([], api(), {}, { quote: quoteId });

describe('refuses to sign a bridge step with no EIP-712 type definition', () => {
  it('throws when the HL action step omits eip712Types', async () => {
    writeQuote('bridge-no-types', {
      id: 'deposit',
      kind: 'transaction',
      items: [{
        data: {
          action: { type: 'sendAsset', parameters: { hyperliquidChain: 'Mainnet', destination: WALLET, amount: '5' } },
          eip712PrimaryType: 'HyperliquidTransaction:SendAsset',
          eip712Types: {},
          nonce: 1700000000000,
        },
      }],
    });
    await expect(execute('bridge-no-types')).rejects.toThrow(
      /missing its EIP-712 type definition.*Refusing to sign/s,
    );
  });

  it('names the offending step so the failure is actionable', async () => {
    writeQuote('bridge-named', {
      id: 'deposit',
      items: [{
        data: {
          action: { type: 'sendAsset', parameters: { hyperliquidChain: 'Mainnet', amount: '5' } },
          eip712PrimaryType: 'HyperliquidTransaction:SendAsset',
          nonce: 1,
        },
      }],
    });
    await expect(execute('bridge-named')).rejects.toThrow(/Bridge step "deposit"/);
  });

  // A primaryType that doesn't match any key in types is the same failure as an
  // absent types map: zero fields, so a signature over nothing.
  it('throws when primaryType does not match the supplied types', async () => {
    writeQuote('bridge-mismatch', {
      id: 'authorize',
      items: [{
        data: {
          sign: {
            domain: { name: 'Relay', version: '1', chainId: 1, verifyingContract: '0x' + '0'.repeat(40) },
            types: { Authorize: [{ name: 'nonce', type: 'uint256' }] },
            primaryType: 'SomethingElse',
            value: { nonce: '1' },
          },
          post: { endpoint: '/authorize', body: {} },
        },
      }],
    });
    await expect(execute('bridge-mismatch')).rejects.toThrow(
      /missing its EIP-712 type definition for "SomethingElse"/,
    );
  });

  it('still signs a step whose types are present', async () => {
    writeQuote('bridge-ok', {
      id: 'authorize',
      items: [{
        data: {
          sign: {
            domain: { name: 'Relay', version: '1', chainId: 1, verifyingContract: '0x' + '0'.repeat(40) },
            types: { Authorize: [{ name: 'nonce', type: 'uint256' }] },
            primaryType: 'Authorize',
            value: { nonce: '1' },
          },
          post: { endpoint: '/authorize', body: {} },
        },
      }],
    });
    await expect(execute('bridge-ok')).resolves.toBeUndefined();
  });
});
