import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadBridgeQuote, markBridgeQuoteExecuted, parseSlippageBps } from '../bridge.js';

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
