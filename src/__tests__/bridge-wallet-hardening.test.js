import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../wallet.js', () => ({
  showWallet: vi.fn(),
  getWalletConfig: vi.fn(() => ({})),
  exportWallet: vi.fn(),
}));

vi.mock('../keychain.js', () => ({
  retrievePassword: vi.fn(() => ({ password: null, source: null })),
}));

vi.mock('../perp.js', () => ({
  screenOrThrow: vi.fn(),
}));

import fs from 'fs';
import os from 'os';
import path from 'path';

import { exportWallet, getWalletConfig, showWallet } from '../wallet.js';
import { retrievePassword } from '../keychain.js';
import { screenOrThrow } from '../perp.js';
import { buildBridgeCommands } from '../bridge.js';

// M6: bridge.js missed the wallet hardening perp.js had. These run through the
// real `bridge execute` so they pin the wiring, not just the shared helper.

const ADDR = '0x' + 'ab'.repeat(20);

let tmpHome;
let prevHome;
let quotesDir;

function writeQuote(quoteId, overrides = {}) {
  const data = {
    quoteId,
    type: 'bridge',
    originChain: 'base',
    destinationChain: 'hyperliquid',
    walletProvider: 'local',
    walletAddress: ADDR,
    timestamp: Date.now(),
    response: { execution_type: 'evm_transaction', steps: [], request_id: 'r1' },
    ...overrides,
  };
  fs.writeFileSync(path.join(quotesDir, `${quoteId}.json`), JSON.stringify(data, null, 2));
}

// Screening has to pass for execution to reach the key-resolution step, and a
// quote with no steps runs straight into completion polling — which loops for ten
// minutes unless the status call answers.
async function respond(endpoint) {
  if (String(endpoint).includes('/bridge/status')) {
    return { status: 'success', raw_status: 'done', destination_tx_hashes: ['0x' + 'de'.repeat(32)] };
  }
  return { results: [{ address: ADDR, sanctioned: false }] };
}

const cleanApi = { request: vi.fn(respond) };

beforeEach(() => {
  vi.clearAllMocks();
  prevHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-bridge-hardening-'));
  process.env.HOME = tmpHome;
  quotesDir = path.join(tmpHome, '.nansen', 'quotes');
  fs.mkdirSync(quotesDir, { recursive: true });
  getWalletConfig.mockReturnValue({});
  retrievePassword.mockReturnValue({ password: null, source: null });
  cleanApi.request.mockImplementation(respond);
});

afterEach(() => {
  process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('bridge execute wallet hardening', () => {
  it('reports PASSWORD_REQUIRED, not "Incorrect password", when nothing was entered', async () => {
    // M6.1, the item flagged as immediate support noise.
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-1');
    showWallet.mockReturnValue({ name: 'w', evm: ADDR, provider: 'local' });
    getWalletConfig.mockReturnValue({ passwordHash: 'h' });

    let err;
    try {
      await cmds.execute([], cleanApi, {}, { quote: 'bridge-1', wallet: 'w' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('PASSWORD_REQUIRED');
    expect(err.message).not.toMatch(/Incorrect password/);
    expect(exportWallet).not.toHaveBeenCalled();
  });

  it('refuses a wallet with no EVM address before any network call', async () => {
    // M6.2: this used to pass wallet.evm through as null and 422 at the API.
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-2');
    showWallet.mockReturnValue({ name: 'sol-only', evm: null, provider: 'local' });

    await expect(
      cmds.execute([], cleanApi, {}, { quote: 'bridge-2', wallet: 'sol-only' }),
    ).rejects.toThrow(/no valid EVM address\. Bridging requires an EVM wallet/);
    expect(cleanApi.request).not.toHaveBeenCalled();
  });

  it('resolves the wallet exactly once for the signer and its key', async () => {
    // M6.3: two resolutions could screen one wallet and sign with another if the
    // default changed in between.
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-3');
    showWallet.mockReturnValue({ name: 'w', evm: ADDR, provider: 'local' });
    exportWallet.mockReturnValue({ evm: { privateKey: '11'.repeat(32) } });

    await cmds.execute([], cleanApi, {}, { quote: 'bridge-3', wallet: 'w' }).catch(() => {});
    expect(showWallet).toHaveBeenCalledTimes(1);
  });

  it('does not try to export a key for a Privy wallet', async () => {
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-4', {
      walletProvider: 'privy',
      response: { execution_type: 'hyperliquid_signature', steps: [], request_id: 'r1' },
    });
    showWallet.mockReturnValue({
      name: 'p',
      evm: ADDR,
      provider: 'privy',
      privyWalletIds: { evm: 'pw-1' },
    });

    await cmds.execute([], cleanApi, {}, { quote: 'bridge-4', wallet: 'p' }).catch(() => {});
    expect(exportWallet).not.toHaveBeenCalled();
  });

  it('screens a distinct bridge recipient with the signer', async () => {
    const recipient = '0x' + 'cd'.repeat(20);
    const cmds = buildBridgeCommands({ log: () => {} });
    showWallet.mockReturnValue({ name: 'w', evm: ADDR, provider: 'local' });
    exportWallet.mockReturnValue({ evm: { privateKey: '11'.repeat(32) } });
    cleanApi.request.mockImplementation(async endpoint => {
      if (String(endpoint).includes('/bridge/quote')) {
        return { execution_type: 'evm_transaction', steps: [], request_id: 'r1' };
      }
      return respond(endpoint);
    });

    await cmds.quote([], cleanApi, {}, {
      'from-chain': 'base',
      'to-chain': 'hyperliquid',
      'from-token': 'USDC',
      amount: '5000000',
      wallet: 'w',
      recipient,
    });
    const quoteId = path.basename(fs.readdirSync(quotesDir)[0], '.json');

    await cmds.execute([], cleanApi, {}, { quote: quoteId, wallet: 'w' });

    expect(screenOrThrow).toHaveBeenCalledWith(cleanApi, [ADDR, recipient]);
  });
});
