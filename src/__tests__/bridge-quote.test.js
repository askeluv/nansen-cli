import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// bridge execute resolves the signing wallet before screening, so the gate tests
// need a wallet to resolve. Mocked at the module boundary, as perp.test.js does.
vi.mock('../wallet.js', () => ({
  showWallet: vi.fn(),
  getWalletConfig: vi.fn(() => ({})),
  exportWallet: vi.fn(),
}));

vi.mock('../keychain.js', () => ({
  retrievePassword: vi.fn(() => ({ password: null, source: null })),
}));
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getWalletConfig, showWallet } from '../wallet.js';
import { buildBridgeCommands, loadBridgeQuote, markBridgeQuoteExecuted, parseSlippageBps } from '../bridge.js';

// loadBridgeQuote/markBridgeQuoteExecuted resolve the quotes dir from
// process.env.HOME, so point HOME at a throwaway dir for each test.

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
    walletAddress: '0xabc',
    timestamp: Date.now(),
    response: { execution_type: 'evm_transaction', steps: [], request_id: 'r1' },
    ...overrides,
  };
  fs.writeFileSync(path.join(quotesDir, `${quoteId}.json`), JSON.stringify(data, null, 2));
  return data;
}

beforeEach(() => {
  prevHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-bridge-'));
  process.env.HOME = tmpHome;
  quotesDir = path.join(tmpHome, '.nansen', 'quotes');
  fs.mkdirSync(quotesDir, { recursive: true });
});

afterEach(() => {
  process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('bridge quote replay protection', () => {
  it('loads a fresh, unexecuted quote', () => {
    writeQuote('bridge-1');
    const data = loadBridgeQuote('bridge-1');
    expect(data.quoteId).toBe('bridge-1');
    expect(data.executedAt).toBeUndefined();
  });

  it('refuses a quote that has already been executed', () => {
    writeQuote('bridge-2');
    markBridgeQuoteExecuted('bridge-2');
    expect(() => loadBridgeQuote('bridge-2')).toThrow(/already executed/);
  });

  it('marking sets an executedAt timestamp on disk', () => {
    writeQuote('bridge-3');
    markBridgeQuoteExecuted('bridge-3');
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(quotesDir, 'bridge-3.json'), 'utf8'),
    );
    expect(typeof onDisk.executedAt).toBe('number');
  });

  it('throws for a missing quote', () => {
    expect(() => loadBridgeQuote('nope')).toThrow(/not found/);
  });

  it('deletes and rejects an expired quote', () => {
    writeQuote('bridge-old', { timestamp: Date.now() - 2 * 3600000 });
    expect(() => loadBridgeQuote('bridge-old')).toThrow(/expired/);
    expect(fs.existsSync(path.join(quotesDir, 'bridge-old.json'))).toBe(false);
  });

  it('marking a missing quote is a no-op (does not throw)', () => {
    expect(() => markBridgeQuoteExecuted('ghost')).not.toThrow();
  });

  it('rejects a non-bridge quote loaded through the bridge path', () => {
    writeQuote('swap-1', { type: 'swap' });
    expect(() => loadBridgeQuote('swap-1')).toThrow(/not a bridge quote/);
  });

  it('consumes the quote after the FIRST broadcast of a multi-step bridge', () => {
    // The double-send case: step 1 goes out, step 2 throws. The quote must
    // already be spent, or a retry re-runs from step 0 and re-broadcasts step 1.
    writeQuote('bridge-partial');
    markBridgeQuoteExecuted('bridge-partial', { broadcastSteps: 1, totalSteps: 2 });
    expect(() => loadBridgeQuote('bridge-partial')).toThrow(/partially executed/);
    expect(() => loadBridgeQuote('bridge-partial')).toThrow(/1 of 2 steps/);
  });

  it('keeps the original executedAt when a later step is marked', () => {
    writeQuote('bridge-progress');
    markBridgeQuoteExecuted('bridge-progress', { broadcastSteps: 1, totalSteps: 2 });
    const first = JSON.parse(
      fs.readFileSync(path.join(quotesDir, 'bridge-progress.json'), 'utf8'),
    ).executedAt;
    markBridgeQuoteExecuted('bridge-progress', { broadcastSteps: 2, totalSteps: 2 });
    const after = JSON.parse(
      fs.readFileSync(path.join(quotesDir, 'bridge-progress.json'), 'utf8'),
    );
    expect(after.executedAt).toBe(first);
    expect(after.broadcastSteps).toBe(2);
  });

  it('never regresses the broadcast count', () => {
    // Marking is best-effort and idempotent; a stale/lower count must not
    // reopen a fully-executed quote as "partial".
    writeQuote('bridge-monotonic');
    markBridgeQuoteExecuted('bridge-monotonic', { broadcastSteps: 2, totalSteps: 2 });
    markBridgeQuoteExecuted('bridge-monotonic', { broadcastSteps: 1, totalSteps: 2 });
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(quotesDir, 'bridge-monotonic.json'), 'utf8'),
    );
    expect(onDisk.broadcastSteps).toBe(2);
    expect(() => loadBridgeQuote('bridge-monotonic')).toThrow(/already executed/);
  });

  it('a fully executed multi-step quote reports as executed, not partial', () => {
    writeQuote('bridge-full');
    markBridgeQuoteExecuted('bridge-full', { broadcastSteps: 2, totalSteps: 2 });
    expect(() => loadBridgeQuote('bridge-full')).toThrow(/already executed/);
  });

  it('consumes the quote on a single broadcast, before any receipt is seen', () => {
    // The receipt-timeout case: eth_sendRawTransaction succeeded, waitForReceipt
    // then threw. Nothing has "completed", but a tx is in flight — a retry must
    // not re-sign it.
    writeQuote('bridge-inflight');
    markBridgeQuoteExecuted('bridge-inflight', {
      broadcast: { step: 'deposit', txHash: '0xabc' },
      totalSteps: 1,
    });
    expect(() => loadBridgeQuote('bridge-inflight')).toThrow(/partially executed/);
    expect(() => loadBridgeQuote('bridge-inflight')).toThrow(/0xabc/);
  });

  it('records every individual broadcast, not just one per step', () => {
    // A single step can carry several fund-moving items.
    writeQuote('bridge-items');
    markBridgeQuoteExecuted('bridge-items', { broadcast: { step: 'deposit', txHash: '0x1' }, totalSteps: 1 });
    markBridgeQuoteExecuted('bridge-items', { broadcast: { step: 'deposit', txHash: '0x2' }, totalSteps: 1 });
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(quotesDir, 'bridge-items.json'), 'utf8'),
    );
    expect(onDisk.broadcasts.map(b => b.txHash)).toEqual(['0x1', '0x2']);
    expect(() => loadBridgeQuote('bridge-items')).toThrow(/2 transaction\(s\) already broadcast/);
  });

  it('reports a completed run as executed even though broadcasts were recorded', () => {
    writeQuote('bridge-done');
    markBridgeQuoteExecuted('bridge-done', { broadcast: { step: 'deposit', txHash: '0x9' }, totalSteps: 1 });
    markBridgeQuoteExecuted('bridge-done', { broadcastSteps: 1, totalSteps: 1 });
    expect(() => loadBridgeQuote('bridge-done')).toThrow(/already executed/);
  });

  it('a signature-step broadcast with no tx hash still consumes the quote', () => {
    writeQuote('bridge-sig');
    markBridgeQuoteExecuted('bridge-sig', { broadcast: { step: 'authorize', txHash: null }, totalSteps: 2 });
    expect(() => loadBridgeQuote('bridge-sig')).toThrow(/1 transaction\(s\) already broadcast/);
  });
});

describe('bridge execute compliance gate', () => {
  const WALLET = '0x8CB9c3F23C7d600fB430bbd171a313D9ea61cEBc';

  // The bridge quote was screened server-side when issued, but it stays valid for
  // an hour and the EVM deposit leg broadcasts straight to a public RPC — so the
  // re-screen here is the only thing standing between a newly-listed address and
  // a fund-moving transaction.
  function mockApi(screen) {
    return {
      request: async (endpoint, body) => {
        if (endpoint.startsWith('/api/v1/sanctions/screen')) return screen(body);
        throw new Error(`unexpected endpoint ${endpoint}`);
      },
    };
  }

  function executableQuote(quoteId) {
    writeQuote(quoteId, {
      walletAddress: WALLET,
      response: {
        execution_type: 'evm_transaction',
        steps: [{ id: 'deposit', items: [] }],
        request_id: 'req-1',
      },
    });
  }

  const execute = (api, quoteId, options = {}) =>
    buildBridgeCommands({ log: () => {} }).execute([], api, {}, { quote: quoteId, ...options });

  beforeEach(() => {
    // Signing wallet matches the quote's wallet unless a test overrides it.
    getWalletConfig.mockReturnValue({ defaultWallet: 'w' });
    showWallet.mockReturnValue({ name: 'w', evm: WALLET, provider: 'local' });
  });

  it('refuses to sign when the resolved wallet is not the quote wallet', async () => {
    // Screening one address while signing with another would move funds from an
    // unscreened wallet — and the cached nonce/from belong to the quote's wallet.
    executableQuote('bridge-wrong-wallet');
    showWallet.mockReturnValue({
      name: 'other',
      evm: '0x1111111111111111111111111111111111111111',
      provider: 'local',
    });
    let screened = false;
    const api = {
      request: async () => {
        screened = true;
        return { results: [] };
      },
    };
    await expect(execute(api, 'bridge-wrong-wallet', { wallet: 'other' })).rejects.toThrow(
      /was created for .* but the signing wallet is/,
    );
    // Refused before screening, so nothing was signed or broadcast either.
    expect(screened).toBe(false);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(quotesDir, 'bridge-wrong-wallet.json'), 'utf8'),
    );
    expect(onDisk.executedAt).toBeUndefined();
  });

  it('screens the address that actually signs', async () => {
    executableQuote('bridge-screens-signer');
    const seen = [];
    const api = {
      request: async (endpoint, body) => {
        seen.push(...(body?.addresses || []));
        return { results: [{ address: WALLET, sanctioned: true }] };
      },
    };
    await expect(execute(api, 'bridge-screens-signer')).rejects.toThrow(/compliance blocklist/);
    expect(seen).toEqual([WALLET]);
  });

  it('refuses to sign when the wallet is sanctioned', async () => {
    executableQuote('bridge-sanctioned');
    const api = mockApi(() => ({ results: [{ address: WALLET, sanctioned: true }] }));
    await expect(execute(api, 'bridge-sanctioned')).rejects.toThrow(/compliance blocklist/);
  });

  it('refuses to sign when screening is unavailable (fail closed)', async () => {
    executableQuote('bridge-screen-down');
    const api = mockApi(() => {
      throw new Error('503 snapshot unavailable');
    });
    await expect(execute(api, 'bridge-screen-down')).rejects.toThrow(/screening is unavailable/);
  });

  it('refuses to sign when the response omits the wallet (unverifiable)', async () => {
    executableQuote('bridge-screen-partial');
    const api = mockApi(() => ({ results: [] }));
    await expect(execute(api, 'bridge-screen-partial')).rejects.toThrow(/did not cover all addresses/);
  });

  it('leaves the quote unconsumed when screening blocks it — nothing was broadcast', async () => {
    executableQuote('bridge-blocked');
    const api = mockApi(() => ({ results: [{ address: WALLET, sanctioned: true }] }));
    await expect(execute(api, 'bridge-blocked')).rejects.toThrow();
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(quotesDir, 'bridge-blocked.json'), 'utf8'),
    );
    expect(onDisk.executedAt).toBeUndefined();
  });
});

describe('bridge --slippage validation', () => {
  it('rejects a non-numeric value client-side instead of forwarding it to the API', () => {
    expect(() => parseSlippageBps('abc')).toThrow(/Invalid --slippage "abc"/);
  });

  it('rejects trailing garbage that parseInt would otherwise truncate', () => {
    expect(() => parseSlippageBps('999abc')).toThrow(/Invalid --slippage/);
  });

  it('rejects a negative value', () => {
    expect(() => parseSlippageBps('-1')).toThrow(/Invalid --slippage "-1"/);
  });

  it('rejects a value above 10000 bps (100%)', () => {
    expect(() => parseSlippageBps('10001')).toThrow(/between 0 and 10000/);
  });

  it('accepts valid basis points', () => {
    expect(parseSlippageBps('50')).toBe(50);
    expect(parseSlippageBps('0')).toBe(0);
    expect(parseSlippageBps('10000')).toBe(10000);
  });
});
