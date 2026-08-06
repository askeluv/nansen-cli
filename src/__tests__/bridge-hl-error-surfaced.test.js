import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A Hyperliquid withdrawal's second step signs an HL action and POSTs it through
// the /perp/bridge/execute proxy. HL rejects an action with HTTP 200 and a
// { status: "err" } body (or an "ok" body carrying per-action errors); the proxy
// forwards that verbatim without flagging it. The CLI used to discard the
// response and print "Submitted", then poll to a 600s timeout with no reason.
// It must now fail loudly with HL's reason and never enter polling.

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

function writeWithdrawQuote(quoteId) {
  fs.writeFileSync(path.join(quotesDir, `${quoteId}.json`), JSON.stringify({
    quoteId,
    type: 'bridge',
    originChain: 'hyperliquid',
    destinationChain: 'base',
    walletProvider: 'local',
    walletAddress: WALLET,
    timestamp: Date.now(),
    response: {
      execution_type: 'hyperliquid_signature',
      request_id: 'req-withdraw-1',
      steps: [
        {
          id: 'authorize',
          kind: 'signature',
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
        },
        {
          id: 'deposit',
          kind: 'transaction',
          items: [{
            data: {
              action: { type: 'sendAsset', parameters: { destination: WALLET, amount: '5' } },
              eip712PrimaryType: 'HyperliquidTransaction:SendAsset',
              eip712Types: {
                'HyperliquidTransaction:SendAsset': [
                  { name: 'destination', type: 'string' },
                  { name: 'amount', type: 'string' },
                ],
              },
              nonce: 1700000000000,
            },
          }],
        },
      ],
    },
  }));
}

// api mock that answers screening + authorize, defers the HL leg to `hlResponse`,
// and records whether the status/poll endpoint was ever hit.
function makeApi(hlResponse) {
  const state = { statusPolled: false };
  const api = {
    request: async (endpoint, body) => {
      if (endpoint.startsWith('/api/v1/sanctions/screen')) {
        return { results: (body?.addresses || []).map(address => ({ address, sanctioned: false })) };
      }
      if (endpoint.startsWith('/api/v1/perp/bridge/status')) {
        state.statusPolled = true;
        return { status: 'success', destination_tx_hashes: ['0xdone'] };
      }
      // execute proxy
      if (body?.target_url === 'https://api.hyperliquid.xyz/exchange') {
        return hlResponse;
      }
      return { success: true, data: { status: 'ok' } }; // relay authorize
    },
  };
  return { api, state };
}

beforeEach(() => {
  prevHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-hl-err-'));
  process.env.HOME = tmpHome;
  quotesDir = path.join(tmpHome, '.nansen', 'quotes');
  fs.mkdirSync(quotesDir, { recursive: true });
  showWallet.mockReturnValue({ name: 'w', evm: WALLET, provider: 'local' });
});

afterEach(() => {
  process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('a Hyperliquid rejection on the withdrawal leg fails loudly', () => {
  it('surfaces a top-level status:"err" reason and never polls', async () => {
    writeWithdrawQuote('bridge-err');
    const { api, state } = makeApi({
      success: true,
      data: { status: 'err', response: 'Must deposit before performing actions. User: 0xabc' },
    });

    await expect(
      buildBridgeCommands({ log: () => {} }).execute([], api, {}, { quote: 'bridge-err' }),
    ).rejects.toThrow(/Hyperliquid rejected bridge step "deposit": Must deposit before performing actions/);
    expect(state.statusPolled).toBe(false);
  });

  it('surfaces per-action errors carried under an "ok" envelope', async () => {
    writeWithdrawQuote('bridge-action-err');
    const { api, state } = makeApi({
      success: true,
      data: { status: 'ok', response: { data: { statuses: [{ error: 'Insufficient spot balance' }] } } },
    });

    await expect(
      buildBridgeCommands({ log: () => {} }).execute([], api, {}, { quote: 'bridge-action-err' }),
    ).rejects.toThrow(/Hyperliquid rejected bridge step "deposit": Insufficient spot balance/);
    expect(state.statusPolled).toBe(false);
  });
});
