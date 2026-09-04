/**
 * Regression test: `nansen trade execute --quote <id>` now has a single-use /
 * idempotency guard on the persisted swap quote, mirroring `nansen bridge
 * execute` (src/bridge.js's `executedAt` + `markBridgeQuoteExecuted`, see
 * `loadBridgeQuote`). `loadQuote` (src/trading.js) checks `data.executedAt`
 * and refuses an already-broadcast quote; `markQuoteExecuted` records the
 * broadcast on the quote file the instant a transaction goes out — at
 * broadcast time, not on success — so a post-broadcast failure (a REVERTED
 * receipt, or a RECEIPT_TIMEOUT that aborts the process, see PR #519's
 * isFatalBroadcastError) still leaves the quote marked spent.
 *
 * Without this guard, a user (or an agent retrying a failed command, which is
 * the default behavior this CLI is designed for) who re-runs the exact same
 * `--quote <id>` after seeing a RECEIPT_TIMEOUT error would re-sign and
 * re-broadcast the swap. On EVM this isn't a harmless resend: the nonce is
 * fetched fresh from the chain on every execute (`getEvmNonce`, 'pending'
 * count), so a second run would get a genuinely new, independently valid
 * nonce and produce a second, distinct, independently broadcastable
 * transaction — not a byte-identical replay a node would reject.
 *
 * This test proves the fix by running the EVM execute path twice against the
 * same saved quote id, with the RPC and Trading API mocked, and asserting the
 * second call is refused before it ever reaches /execute.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { saveQuote, buildTradingCommands, evmTxHash, getQuotesDir } from '../trading.js';
import { createWallet, showWallet } from '../wallet.js';

const BASE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const LIFI_ROUTER = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';

function evmIntent({ walletAddress, fromToken, toToken, amount, maxInputAmount = amount }) {
  return {
    chain: 'base',
    toChain: null,
    walletAddress,
    recipient: null,
    fromToken,
    toToken,
    swapMode: 'exactIn',
    amount,
    maxInputAmount,
  };
}

describe('swap quote reuse guard (mirrors bridge quotes)', () => {
  let originalHome;
  let tempDir;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-quote-reuse-test-'));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.NANSEN_WALLET_PASSWORD;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function saveEvmQuote(walletAddress) {
    return saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_ETH,
        outputMint: BASE_USDC,
        inAmount: '1000000000000000000',
        outAmount: '3000000000',
        transaction: {
          to: LIFI_ROUTER,
          data: '0x12345678',
          value: '1000000000000000000',
          gas: '210000',
          maxFeePerGas: '1000000',
          maxPriorityFeePerGas: '1000000',
        },
      }],
    }, 'base', 'local', null, null, {
      swapMode: 'exactIn',
      request: evmIntent({
        walletAddress,
        fromToken: BASE_ETH,
        toToken: BASE_USDC,
        amount: '1000000000000000000',
      }),
    });
  }

  it('refuses a second execute of the same --quote id, with no second broadcast', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const walletAddress = showWallet('default').evm;

    const executeBodies = [];
    // getEvmNonce fetches BOTH 'pending' and 'latest' via eth_getTransactionCount
    // on every execute() call — 'pending' is what a real node would already have
    // bumped after the first broadcast sits in the mempool, so a second (refused)
    // execute would have gotten a genuinely new, independently valid nonce, not a
    // byte-identical resend a node would reject. Modeled here so the guard is
    // proven against a realistic second attempt, not a no-op one.
    let pendingNonceCalls = 0;

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? JSON.parse(opts.body) : {};

      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(body);
        const txHash = evmTxHash(body.signedTransaction);
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', chainType: 'evm', broadcaster: 'test', txHash })),
        });
      }

      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      }
      if (body.method === 'eth_getTransactionCount') {
        const isPending = body.params?.[1] === 'pending';
        if (isPending) pendingNonceCalls += 1;
        const result = isPending ? (pendingNonceCalls === 1 ? '0x5' : '0x6') : '0x5';
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })) });
      }
      if (body.method === 'eth_getTransactionReceipt') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { status: '0x1', blockNumber: '0x100' } })) });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const quoteId = saveEvmQuote(walletAddress);
    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    const flags = { 'no-simulate': true, 'no-verify-outcome': true };

    // First run: broadcasts and confirms normally.
    await cmds.execute([], null, flags, { quote: quoteId });
    expect(executeBodies).toHaveLength(1);

    // Second run against the SAME quote id must be refused by loadQuote's
    // `data.executedAt` check (markQuoteExecuted recorded the first broadcast)
    // before it ever reaches /execute again.
    await expect(cmds.execute([], null, flags, { quote: quoteId }))
      .rejects.toThrow(/already executed/i);

    expect(executeBodies).toHaveLength(1);

    // The quote file itself carries the marker — not a new side record.
    const quoteFile = JSON.parse(fs.readFileSync(path.join(getQuotesDir(), `${quoteId}.json`), 'utf8'));
    expect(quoteFile.executedAt).toBeTypeOf('number');
    expect(quoteFile.broadcasts?.[0]?.txHash).toBeTruthy();
  });

  it('refuses a retry after the first run broadcasts then times out waiting for the receipt (RECEIPT_TIMEOUT)', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const walletAddress = showWallet('default').evm;

    const executeBodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? JSON.parse(opts.body) : {};

      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(body);
        const txHash = evmTxHash(body.signedTransaction);
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', chainType: 'evm', broadcaster: 'test', txHash })),
        });
      }

      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      }
      if (body.method === 'eth_getTransactionCount') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      }
      if (body.method === 'eth_getTransactionReceipt') {
        // The tx is on-chain (or in flight) but the receipt never lands within
        // the poll window — a pending tx, NOT a confirmed revert.
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null })) });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const quoteId = saveEvmQuote(walletAddress);
    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    const flags = { 'no-simulate': true, 'no-verify-outcome': true };

    // First run: broadcasts successfully, then the receipt wait times out and
    // the command exits with RECEIPT_TIMEOUT — the tx may still be pending.
    vi.useFakeTimers();
    const firstRun = cmds.execute([], null, flags, { quote: quoteId });
    const firstSettle = expect(firstRun).rejects.toMatchObject({ code: 'RECEIPT_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(200000); // past the 180s waitForReceipt window
    await firstSettle;
    vi.useRealTimers();

    expect(executeBodies).toHaveLength(1);

    // The quote must already be marked spent — markQuoteExecuted runs at
    // broadcast time (before the receipt wait), not on success.
    const quoteFile = JSON.parse(fs.readFileSync(path.join(getQuotesDir(), `${quoteId}.json`), 'utf8'));
    expect(quoteFile.executedAt).toBeTypeOf('number');

    // Second run — the natural retry after seeing a non-zero exit — must be
    // refused before it ever re-signs and re-broadcasts under a fresh nonce.
    await expect(cmds.execute([], null, flags, { quote: quoteId }))
      .rejects.toThrow(/already executed/i);

    expect(executeBodies).toHaveLength(1);
  });

  it('marks the quote spent when /execute returns a non-Success status with a txHash', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const walletAddress = showWallet('default').evm;

    const executeBodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? JSON.parse(opts.body) : {};

      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(body);
        // Same response shape observed for approval broadcasts in
        // trading.test.js ("fails closed when reapproval fails after a
        // successful revoke"): status !== 'Success' alongside a txHash.
        const txHash = evmTxHash(body.signedTransaction);
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Failed', error: 'simulation reverted', chainType: 'evm', broadcaster: 'test', txHash })),
        });
      }

      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      }
      if (body.method === 'eth_getTransactionCount') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const quoteId = saveEvmQuote(walletAddress);
    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    const flags = { 'no-simulate': true, 'no-verify-outcome': true };

    // Single-candidate quote, so the Failed result exhausts the loop.
    await expect(cmds.execute([], null, flags, { quote: quoteId }))
      .rejects.toThrow(/all quotes failed/i);
    expect(executeBodies).toHaveLength(1);

    const quoteFile = JSON.parse(fs.readFileSync(path.join(getQuotesDir(), `${quoteId}.json`), 'utf8'));
    expect(quoteFile.executedAt).toBeTypeOf('number');
    expect(quoteFile.broadcasts?.[0]?.txHash).toBeTruthy();

    // A retry must be refused, not re-broadcast under a fresh nonce.
    await expect(cmds.execute([], null, flags, { quote: quoteId }))
      .rejects.toThrow(/already executed/i);
    expect(executeBodies).toHaveLength(1);
  });

  it('fails closed on BROADCAST_FAILED: marks the quote spent and never tries the next candidate', async () => {
    // The gap this locks in: /execute retries a 502 and, if all attempts fail,
    // throws BROADCAST_FAILED — but a 502 on the ACK (not the send) means the tx
    // may already be live. The old code left the quote unmarked and fell through
    // to the next candidate, double-broadcasting both in-run and via a later
    // re-execute. isFatalBroadcastError now covers BROADCAST_FAILED, and the
    // candidate catch marks the quote spent before aborting.
    const SECOND_ROUTER = '0x1111111254eeb25477b68fb85ed929f73a960582';
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const walletAddress = showWallet('default').evm;

    const executeBodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? JSON.parse(opts.body) : {};

      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(body);
        // A 502 gateway page — NON-JSON — on every attempt: executeTransaction
        // exhausts its 502 retries and throws BROADCAST_FAILED.
        return Promise.resolve({ ok: false, status: 502, text: () => Promise.resolve('<html>502 Bad Gateway</html>') });
      }
      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      }
      if (body.method === 'eth_getTransactionCount') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    // TWO candidates: if the fix regressed, the loop would fall through and sign
    // + broadcast the SECOND on top of a possibly-live first tx.
    const quoteId = saveQuote({
      success: true,
      quotes: [
        { aggregator: 'lifi', inputMint: BASE_ETH, outputMint: BASE_USDC, inAmount: '1000000000000000000', outAmount: '3000000000',
          transaction: { to: LIFI_ROUTER, data: '0x12345678', value: '1000000000000000000', gas: '210000', maxFeePerGas: '1000000', maxPriorityFeePerGas: '1000000' } },
        { aggregator: 'odos', inputMint: BASE_ETH, outputMint: BASE_USDC, inAmount: '1000000000000000000', outAmount: '2999000000',
          transaction: { to: SECOND_ROUTER, data: '0xabcdef01', value: '1000000000000000000', gas: '210000', maxFeePerGas: '1000000', maxPriorityFeePerGas: '1000000' } },
      ],
    }, 'base', 'local', null, null, {
      swapMode: 'exactIn',
      request: evmIntent({ walletAddress, fromToken: BASE_ETH, toToken: BASE_USDC, amount: '1000000000000000000' }),
    });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    const flags = { 'no-simulate': true, 'no-verify-outcome': true };

    await expect(cmds.execute([], null, flags, { quote: quoteId }))
      .rejects.toThrow(/502|bad gateway/i);

    // Only the FIRST candidate was ever posted (its retries) — every /execute
    // body carries the same signed tx, so the second candidate never went out.
    expect(executeBodies.length).toBeGreaterThan(0);
    expect(new Set(executeBodies.map(b => b.signedTransaction)).size).toBe(1);

    // The quote is marked spent even though executeTransaction threw before the
    // normal markQuoteExecuted could run. No broadcast hash is recorded (we hold
    // none), so loadQuote falls back to its generic "already executed" refusal.
    const quoteFile = JSON.parse(fs.readFileSync(path.join(getQuotesDir(), `${quoteId}.json`), 'utf8'));
    expect(quoteFile.executedAt).toBeTypeOf('number');

    // A cross-process retry (or an agent auto-retry) is refused before re-signing.
    const postCount = executeBodies.length;
    await expect(cmds.execute([], null, flags, { quote: quoteId }))
      .rejects.toThrow(/already executed/i);
    expect(executeBodies.length).toBe(postCount);
  });
});
