import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Withdrawal destinations (hyperliquid -> ethereum/arbitrum) are supported even
// though local EVM signing only knows Base, because a withdrawal signs a
// Hyperliquid action and never transacts on the destination chain. That is the
// entire justification for those routes being in BRIDGE_ROUTES, so it gets a
// test rather than a comment: signEvmTransaction is replaced with a spy that
// throws, and a full withdrawal execute has to complete without touching it.
//
// Relay labels the second withdrawal step `kind: "transaction"` even though its
// payload is a Hyperliquid action, so this also pins the dispatch to
// execution_type rather than the step's own kind.
// vi.hoisted, because vi.mock's factory is hoisted above normal top-level consts.
const { signEvmTransaction, evmRpcCall, getEvmNonce } = vi.hoisted(() => ({
  signEvmTransaction: vi.fn(() => {
    throw new Error('signEvmTransaction must not be reached on a withdrawal');
  }),
  // Stubbed so the deposit control test below can reach the signing call
  // without touching a real RPC.
  evmRpcCall: vi.fn(async () => '0x1'),
  getEvmNonce: vi.fn(async () => 0),
}));

vi.mock('../trading.js', async (importOriginal) => ({
  ...(await importOriginal()),
  signEvmTransaction,
  evmRpcCall,
  getEvmNonce,
}));

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

const WALLET = '0x8CB9c3F23C7d600fB430bbd171a313D9ea61cEBc';

let tmpHome;
let prevHome;
let quotesDir;

// Shaped after a live `hyperliquid -> arbitrum` quote: an authorize signature
// step, then an HL action step that Relay marks as a transaction.
function writeWithdrawQuote(quoteId, destinationChain) {
  const data = {
    quoteId,
    type: 'bridge',
    originChain: 'hyperliquid',
    destinationChain,
    walletProvider: 'local',
    walletAddress: WALLET,
    requestedAmountBaseUnits: '500000000',
    timestamp: Date.now(),
    response: {
      execution_type: 'hyperliquid_signature',
      request_id: 'req-withdraw-1',
      details: { currencyIn: { amount: '500000000', amountFormatted: '5.0' } },
      steps: [
        {
          id: 'authorize',
          kind: 'signature',
          items: [
            {
              data: {
                sign: {
                  domain: {
                    name: 'Relay',
                    version: '1',
                    chainId: 1,
                    verifyingContract: '0x0000000000000000000000000000000000000000',
                  },
                  types: { Authorize: [{ name: 'nonce', type: 'uint256' }] },
                  primaryType: 'Authorize',
                  value: { nonce: '1' },
                },
                post: { endpoint: '/authorize', body: {} },
              },
            },
          ],
        },
        {
          id: 'deposit',
          kind: 'transaction',
          items: [
            {
              data: {
                action: { type: 'sendAsset', parameters: { hyperliquidChain: 'Mainnet', destination: WALLET, amount: '5' } },
                eip712PrimaryType: 'HyperliquidTransaction:SendAsset',
                eip712Types: {
                  'HyperliquidTransaction:SendAsset': [
                    { name: 'destination', type: 'string' },
                    { name: 'amount', type: 'string' },
                  ],
                },
                nonce: 1700000000000,
              },
            },
          ],
        },
      ],
    },
  };
  fs.writeFileSync(path.join(quotesDir, `${quoteId}.json`), JSON.stringify(data, null, 2));
}

beforeEach(() => {
  prevHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-bridge-wd-'));
  process.env.HOME = tmpHome;
  quotesDir = path.join(tmpHome, '.nansen', 'quotes');
  fs.mkdirSync(quotesDir, { recursive: true });
  signEvmTransaction.mockClear();
  showWallet.mockReturnValue({ name: 'w', evm: WALLET, provider: 'local' });
});

afterEach(() => {
  process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('hyperliquid withdrawals never sign an EVM transaction', () => {
  for (const destination of ['base', 'ethereum', 'arbitrum']) {
    it(`completes a hyperliquid -> ${destination} withdrawal without EVM signing`, async () => {
      writeWithdrawQuote(`bridge-wd-${destination}`, destination);

      const posted = [];
      const api = {
        request: async (endpoint, body) => {
          // Screening is fail-closed, so the stub has to cover every requested
          // address or execute aborts before reaching the signing path at all.
          if (endpoint.startsWith('/api/v1/sanctions/screen')) {
            return { results: (body?.addresses || []).map(address => ({ address, sanctioned: false })) };
          }
          // Terminal status straight away, so execute returns instead of
          // sitting in pollBridgeCompletion's 10-minute retry loop.
          if (endpoint.startsWith('/api/v1/perp/bridge/status')) {
            return { status: 'success', destination_tx_hashes: ['0xdone'] };
          }
          posted.push(body?.target_url ?? endpoint);
          return { status: 'ok' };
        },
      };

      await buildBridgeCommands({ log: () => {} }).execute([], api, {}, {
        quote: `bridge-wd-${destination}`,
      });

      // The load-bearing assertion: local EVM signing was never entered, so the
      // destination chain being absent from CHAIN_MAP cannot matter.
      expect(signEvmTransaction).not.toHaveBeenCalled();
      // Both steps went out via the HL/Relay signature path.
      expect(posted).toHaveLength(2);
    });
  }

  // Control: without this, the assertions above would pass just as happily if
  // the spy were never wired to the module at all.
  it('does reach EVM signing on a deposit, proving the spy is wired', async () => {
    const quoteId = 'bridge-deposit-control';
    fs.writeFileSync(
      path.join(quotesDir, `${quoteId}.json`),
      JSON.stringify({
        quoteId,
        type: 'bridge',
        originChain: 'base',
        destinationChain: 'hyperliquid',
        walletProvider: 'local',
        walletAddress: WALLET,
        timestamp: Date.now(),
        response: {
          execution_type: 'evm_transaction',
          request_id: 'req-deposit-1',
          steps: [
            {
              id: 'deposit',
              kind: 'transaction',
              items: [{ data: { from: WALLET, to: WALLET, data: '0x', value: '0', gas: '21000' } }],
            },
          ],
        },
      }),
    );

    const api = {
      request: async (endpoint, body) => {
        if (endpoint.startsWith('/api/v1/sanctions/screen')) {
          return { results: (body?.addresses || []).map(address => ({ address, sanctioned: false })) };
        }
        return { status: 'success' };
      },
    };

    // The spy throws, so reaching it surfaces as a rejection.
    await expect(
      buildBridgeCommands({ log: () => {} }).execute([], api, {}, { quote: quoteId }),
    ).rejects.toThrow(/must not be reached on a withdrawal/);
    expect(signEvmTransaction).toHaveBeenCalledOnce();
  });
});
