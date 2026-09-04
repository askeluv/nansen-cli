/**
 * A bridge broadcast that FAILS AMBIGUOUSLY (a non-JSON gateway page,
 * a dropped connection) after the node may already have accepted the tx must
 * consume the quote — otherwise a later `nansen bridge execute --quote <id>`
 * (or an agent auto-retry) re-signs the step at a fresh nonce and double-sends.
 *
 * The client cannot distinguish "502, tx never sent" from "502, tx sent, ack
 * lost", so it fails closed by default: a send failure marks the quote spent
 * UNLESS the node's error proves the tx never entered the mempool. Only a
 * pre-broadcast validation rejection (insufficient funds, intrinsic gas too
 * low, underpriced, malformed, …) — or a missing-RPC config error — keeps the
 * quote reusable. Crucially, in-flight txpool states ("already known", "known
 * transaction", "nonce too low", "replacement transaction underpriced") also
 * come back as JSON-RPC errors, but the tx is already broadcasting, so those
 * fail closed too.
 *
 * See src/bridge.js processEvmStep + isPreBroadcastSendRejection, and
 * evmRpcCall's error codes in src/trading.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../wallet.js', () => ({
  showWallet: vi.fn(),
  getWalletConfig: vi.fn(() => ({})),
  exportWallet: vi.fn(),
}));

vi.mock('../keychain.js', () => ({
  retrievePassword: vi.fn(() => ({ password: null, source: null })),
}));

const { evmRpcCall, getEvmNonce, signEvmTransaction, waitForReceipt } = vi.hoisted(() => ({
  evmRpcCall: vi.fn(),
  getEvmNonce: vi.fn(async () => 7),
  signEvmTransaction: vi.fn(() => '0xsigned'),
  waitForReceipt: vi.fn(async () => ({ status: '0x1', blockNumber: '0x1' })),
}));

vi.mock('../trading.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, evmRpcCall, getEvmNonce, signEvmTransaction, waitForReceipt };
});

import fs from 'fs';
import os from 'os';
import path from 'path';

import { exportWallet, getWalletConfig, showWallet } from '../wallet.js';
import { buildBridgeCommands } from '../bridge.js';

const ADDR = '0x' + 'ab'.repeat(20);
// Real Base -> Hyperliquid deposit router/selector — the preflight rejects
// anything else, so the fixture needs well-formed deposit calldata.
const ROUTER = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const REQUESTED_AMOUNT = 2000000n;
const word = h => h.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const depositCalldata = (depositor, amount = REQUESTED_AMOUNT) =>
  '0xe8017952' + word(depositor) + word(USDC) + word(amount.toString(16)) + word('0x'.padEnd(66, 'a'));

describe('bridge EVM broadcast fail-closed', () => {
  let tmpHome;
  let prevHome;
  let quotesDir;

  function writeQuote(quoteId) {
    const data = {
      quoteId,
      type: 'bridge',
      originChain: 'base',
      destinationChain: 'hyperliquid',
      walletProvider: 'local',
      walletAddress: ADDR,
      requestedAmountBaseUnits: REQUESTED_AMOUNT.toString(),
      timestamp: Date.now(),
      response: {
        execution_type: 'evm_transaction',
        request_id: 'r1',
        steps: [{
          id: 'deposit',
          kind: 'transaction',
          items: [{
            status: 'incomplete',
            data: { from: ADDR, to: ROUTER, data: depositCalldata(ADDR), value: '0', maxFeePerGas: '1000000' },
          }],
        }],
      },
    };
    fs.writeFileSync(path.join(quotesDir, `${quoteId}.json`), JSON.stringify(data, null, 2));
  }

  const api = {
    request: vi.fn(async (endpoint) => {
      if (String(endpoint).includes('/bridge/status')) return { status: 'success', destination_tx_hashes: [] };
      return { results: [{ address: ADDR, sanctioned: false }] };
    }),
  };

  // Make eth_sendRawTransaction reject with `sendError`; everything else the
  // step needs (base fee) resolves normally.
  function stubSend(sendError) {
    evmRpcCall.mockImplementation(async (_chain, method) => {
      if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
      if (method === 'eth_sendRawTransaction') throw sendError;
      return '0x0';
    });
  }

  function readQuote(quoteId) {
    return JSON.parse(fs.readFileSync(path.join(quotesDir, `${quoteId}.json`), 'utf8'));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    prevHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-bridge-failclosed-'));
    process.env.HOME = tmpHome;
    quotesDir = path.join(tmpHome, '.nansen', 'quotes');
    fs.mkdirSync(quotesDir, { recursive: true });
    getWalletConfig.mockReturnValue({});
    showWallet.mockReturnValue({ name: 'w', evm: ADDR, provider: 'local' });
    exportWallet.mockReturnValue({ evm: { privateKey: '11'.repeat(32) } });
    getEvmNonce.mockResolvedValue(7);
    api.request.mockImplementation(async (endpoint) => {
      if (String(endpoint).includes('/bridge/status')) return { status: 'success', destination_tx_hashes: [] };
      return { results: [{ address: ADDR, sanctioned: false }] };
    });
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('marks the quote spent on an AMBIGUOUS send failure (non-JSON 502) and refuses a re-execute', async () => {
    stubSend(Object.assign(new Error('RPC endpoint returned non-JSON response (HTTP 502)'), { code: 'RPC_HTTP_ERROR', status: 502 }));
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-502');

    await expect(cmds.execute([], api, {}, { quote: 'bridge-502', wallet: 'w' }))
      .rejects.toThrow(/non-JSON|502/i);

    // The tx may be live — the quote is consumed even though onBroadcast never
    // ran with a real hash.
    const q = readQuote('bridge-502');
    expect(q.executedAt).toBeTypeOf('number');

    // A retry is refused before it re-signs anything.
    signEvmTransaction.mockClear();
    await expect(cmds.execute([], api, {}, { quote: 'bridge-502', wallet: 'w' }))
      .rejects.toThrow(/partially executed|already executed/i);
    expect(signEvmTransaction).not.toHaveBeenCalled();
  });

  it('marks the quote spent when the send throws a bare NETWORK error (dropped connection)', async () => {
    // evmRpcCall wraps a fetch rejection as RPC_NETWORK_ERROR — also ambiguous.
    stubSend(Object.assign(new Error('RPC request to base failed for eth_sendRawTransaction: socket hang up'), { code: 'RPC_NETWORK_ERROR' }));
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-net');

    await expect(cmds.execute([], api, {}, { quote: 'bridge-net', wallet: 'w' }))
      .rejects.toThrow(/socket hang up|failed for/i);

    expect(readQuote('bridge-net').executedAt).toBeTypeOf('number');
  });

  it('leaves the quote REUSABLE on a PRE-BROADCAST JSON-RPC rejection (insufficient funds)', async () => {
    // The node rejected the tx during validation — it never entered the mempool
    // — so a burned quote here would be a needless re-quote for a plainly
    // retryable error (fund the wallet and re-run the same quote).
    stubSend(Object.assign(new Error('RPC error (eth_sendRawTransaction): insufficient funds for gas * price + value'), { code: 'RPC_JSON_ERROR' }));
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-funds');

    await expect(cmds.execute([], api, {}, { quote: 'bridge-funds', wallet: 'w' }))
      .rejects.toThrow(/insufficient funds/i);

    // Not consumed: no executedAt, and a second attempt actually re-signs
    // (it is NOT blocked by the single-use guard).
    expect(readQuote('bridge-funds').executedAt).toBeUndefined();
    signEvmTransaction.mockClear();
    await expect(cmds.execute([], api, {}, { quote: 'bridge-funds', wallet: 'w' }))
      .rejects.toThrow(/insufficient funds/i);
    expect(signEvmTransaction).toHaveBeenCalled();
  });

  // In-flight txpool states come back as JSON-RPC errors too, but the tx is
  // ALREADY broadcasting — these MUST fail closed, not stay reusable.
  it.each([
    ['already known', 'already known'],
    ['known transaction', 'known transaction: 0xabc'],
    ['nonce too low', 'nonce too low'],
    ['replacement underpriced', 'replacement transaction underpriced'],
  ])('marks the quote spent on an in-flight txpool JSON-RPC error (%s)', async (label, message) => {
    stubSend(Object.assign(new Error(`RPC error (eth_sendRawTransaction): ${message}`), { code: 'RPC_JSON_ERROR' }));
    const cmds = buildBridgeCommands({ log: () => {} });
    const qid = `bridge-inflight-${label.replace(/\s+/g, '-')}`;
    writeQuote(qid);

    await expect(cmds.execute([], api, {}, { quote: qid, wallet: 'w' }))
      .rejects.toThrow(new RegExp(message.split(':')[0], 'i'));

    // The tx may already be in the mempool — the quote is consumed, and a retry
    // is refused before it re-signs.
    expect(readQuote(qid).executedAt).toBeTypeOf('number');
    signEvmTransaction.mockClear();
    await expect(cmds.execute([], api, {}, { quote: qid, wallet: 'w' }))
      .rejects.toThrow(/partially executed|already executed/i);
    expect(signEvmTransaction).not.toHaveBeenCalled();
  });
});
