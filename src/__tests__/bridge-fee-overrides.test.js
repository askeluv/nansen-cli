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
import { buildBridgeCommands, parseGweiToWei, resolveEvmStepFees } from '../bridge.js';

// P2: once a transaction is stuck, the CLI recomputed identical fees, so no retry
// could ever replace it — every attempt returned "replacement transaction
// underpriced". These pin the override path that makes replacement possible.

const ADDR = '0x' + 'ab'.repeat(20);

describe('parseGweiToWei', () => {
  it('converts whole gwei', () => {
    expect(parseGweiToWei('1', 'priority-fee')).toBe(1000000000n);
  });

  it('converts a fractional gwei exactly, without float drift', () => {
    expect(parseGweiToWei('0.05', 'priority-fee')).toBe(50000000n);
    expect(parseGweiToWei('0.001', 'priority-fee')).toBe(1000000n);
    expect(parseGweiToWei('1.234567891', 'max-fee')).toBe(1234567891n);
  });

  it('rejects garbage, zero and negatives', () => {
    expect(() => parseGweiToWei('abc', 'priority-fee')).toThrow(/Give a fee in gwei/);
    expect(() => parseGweiToWei('0.05abc', 'priority-fee')).toThrow(/Give a fee in gwei/);
    expect(() => parseGweiToWei('-1', 'priority-fee')).toThrow(/Give a fee in gwei/);
    expect(() => parseGweiToWei('0', 'priority-fee')).toThrow(/greater than zero/);
  });
});

describe('resolveEvmStepFees overrides', () => {
  const quoted = { maxFeePerGas: '1000000', maxPriorityFeePerGas: '1100000' };

  beforeEach(() => {
    vi.clearAllMocks();
    evmRpcCall.mockResolvedValue({ baseFeePerGas: '0x1' });
  });

  it('uses the quoted fees, floored, with no overrides', async () => {
    const fees = await resolveEvmStepFees('base', quoted);
    // Below the 0.01 gwei floor, so lifted to it.
    expect(fees.maxPriorityFeePerGas).toBe('10000000');
  });

  it('lets --priority-fee win over the computed floor', async () => {
    const fees = await resolveEvmStepFees('base', quoted, { priorityFeeWei: 50000000n });
    expect(fees.maxPriorityFeePerGas).toBe('50000000');
    // The cap has to cover it.
    expect(BigInt(fees.maxFeePerGas)).toBeGreaterThanOrEqual(50000000n);
  });

  it('lets --priority-fee go BELOW the floor when asked', async () => {
    // The floor is a default, not a policy — an operator pricing for a quiet
    // chain must be able to go under it.
    const fees = await resolveEvmStepFees('base', quoted, { priorityFeeWei: 1000n });
    expect(fees.maxPriorityFeePerGas).toBe('1000');
  });

  it('uses --max-fee as the cap verbatim', async () => {
    const fees = await resolveEvmStepFees('base', quoted, {
      priorityFeeWei: 50000000n,
      maxFeeWei: 900000000n,
    });
    expect(fees).toEqual({ maxFeePerGas: '900000000', maxPriorityFeePerGas: '50000000' });
    // An explicit cap is authoritative, so no base-fee lookup is needed.
    expect(evmRpcCall).not.toHaveBeenCalled();
  });

  it('refuses a cap below the priority fee', async () => {
    await expect(
      resolveEvmStepFees('base', quoted, { priorityFeeWei: 50000000n, maxFeeWei: 100n }),
    ).rejects.toThrow(/--max-fee is below --priority-fee/);
  });

  it('produces type-2 fields from overrides even for a legacy-shaped quote', async () => {
    const fees = await resolveEvmStepFees('base', { gasPrice: '1000' }, { priorityFeeWei: 50000000n });
    expect(fees.maxPriorityFeePerGas).toBe('50000000');
    expect(fees.gasPrice).toBeUndefined();
  });
});

describe('bridge execute overrides', () => {
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
      response: {
        execution_type: 'evm_transaction',
        request_id: 'r1',
        steps: [
          {
            id: 'deposit',
            kind: 'transaction',
            items: [{ status: 'incomplete', data: { from: ADDR, to: ADDR, data: '0x', maxFeePerGas: '1000000' } }],
          },
        ],
      },
      ...overrides,
    };
    fs.writeFileSync(path.join(quotesDir, `${quoteId}.json`), JSON.stringify(data, null, 2));
  }

  const api = {
    request: vi.fn(async (endpoint) => {
      if (String(endpoint).includes('/bridge/status')) return { status: 'success', destination_tx_hashes: [] };
      return { results: [{ address: ADDR, sanctioned: false }] };
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prevHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-bridge-fees-'));
    process.env.HOME = tmpHome;
    quotesDir = path.join(tmpHome, '.nansen', 'quotes');
    fs.mkdirSync(quotesDir, { recursive: true });
    getWalletConfig.mockReturnValue({});
    showWallet.mockReturnValue({ name: 'w', evm: ADDR, provider: 'local' });
    exportWallet.mockReturnValue({ evm: { privateKey: '11'.repeat(32) } });
    evmRpcCall.mockImplementation(async (chain, method) => {
      if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
      if (method === 'eth_sendRawTransaction') return '0x' + 'cd'.repeat(32);
      return '0x0';
    });
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

  it('signs at the next nonce by default', async () => {
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-1');
    await cmds.execute([], api, {}, { quote: 'bridge-1', wallet: 'w' });
    expect(getEvmNonce).toHaveBeenCalled();
    expect(signEvmTransaction).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'base', 7);
  });

  it('refuses a step whose txData.from is not the signing wallet', async () => {
    // M2: the wallet==quote guard passes (walletAddress is the signer), but the
    // per-step `from` the server returned points at a different account. Without
    // the assertion the nonce is fetched for the wrong address and signed anyway.
    const OTHER = '0x' + 'cd'.repeat(20);
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-mismatch', {
      response: {
        execution_type: 'evm_transaction',
        request_id: 'r1',
        steps: [
          {
            id: 'deposit',
            kind: 'transaction',
            items: [{ status: 'incomplete', data: { from: OTHER, to: ADDR, data: '0x', maxFeePerGas: '1000000' } }],
          },
        ],
      },
    });
    await expect(
      cmds.execute([], api, {}, { quote: 'bridge-mismatch', wallet: 'w' }),
    ).rejects.toMatchObject({ code: 'SIGNER_MISMATCH' });
    expect(getEvmNonce).not.toHaveBeenCalled();
    expect(signEvmTransaction).not.toHaveBeenCalled();
  });

  it('resolves the nonce for the signer even when the step omits txData.from', async () => {
    // The tx is signed with the local key regardless of `from`, so the nonce must
    // be fetched for the signer — a quote missing `from` must not resolve a nonce
    // for `undefined`.
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-nofrom', {
      response: {
        execution_type: 'evm_transaction',
        request_id: 'r2',
        steps: [
          {
            id: 'deposit',
            kind: 'transaction',
            items: [{ status: 'incomplete', data: { to: ADDR, data: '0x', maxFeePerGas: '1000000' } }],
          },
        ],
      },
    });
    await cmds.execute([], api, {}, { quote: 'bridge-nofrom', wallet: 'w' });
    expect(getEvmNonce).toHaveBeenCalledWith('base', ADDR);
    expect(signEvmTransaction).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'base', 7);
  });

  it('signs at --nonce, bypassing the pending reconciliation', async () => {
    // Replacing a stuck transaction means reusing its nonce, which is exactly
    // what getEvmNonce refuses to hand out.
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-2');
    await cmds.execute([], api, {}, { quote: 'bridge-2', wallet: 'w', nonce: '20' });
    expect(getEvmNonce).not.toHaveBeenCalled();
    expect(signEvmTransaction).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'base', 20);
  });

  it('passes --priority-fee through to the signed transaction', async () => {
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-3');
    await cmds.execute([], api, {}, { quote: 'bridge-3', wallet: 'w', 'priority-fee': '0.05' });
    const [txData] = signEvmTransaction.mock.calls[0];
    expect(txData.maxPriorityFeePerGas).toBe('50000000');
  });

  it('reports the overrides in use rather than applying them silently', async () => {
    const lines = [];
    const cmds = buildBridgeCommands({ log: (m) => lines.push(m) });
    writeQuote('bridge-4');
    await cmds.execute([], api, {}, {
      quote: 'bridge-4', wallet: 'w', nonce: '20', 'priority-fee': '0.05',
    });
    const line = lines.find(l => l.includes('Overrides:'));
    expect(line).toMatch(/priority fee 50000000 wei/);
    expect(line).toMatch(/starting nonce 20/);
  });

  it('rejects a non-numeric --nonce', async () => {
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-5');
    await expect(
      cmds.execute([], api, {}, { quote: 'bridge-5', wallet: 'w', nonce: '20abc' }),
    ).rejects.toThrow(/Invalid --nonce/);
  });

  it('refuses overrides on a withdrawal leg, which has no transaction to price', async () => {
    const cmds = buildBridgeCommands({ log: () => {} });
    writeQuote('bridge-6', {
      originChain: 'hyperliquid',
      destinationChain: 'base',
      response: { execution_type: 'hyperliquid_signature', steps: [], request_id: 'r1' },
    });
    await expect(
      cmds.execute([], api, {}, { quote: 'bridge-6', wallet: 'w', 'priority-fee': '0.05' }),
    ).rejects.toThrow(/apply only to EVM deposit legs/);
  });

  it('numbers a multi-step quote consecutively from --nonce', async () => {
    const cmds = buildBridgeCommands({ log: () => {} });
    const twoSteps = {
      response: {
        execution_type: 'evm_transaction',
        request_id: 'r1',
        steps: [
          {
            id: 'approve',
            kind: 'transaction',
            items: [{ status: 'incomplete', data: { from: ADDR, to: ADDR, data: '0x', maxFeePerGas: '1000000' } }],
          },
          {
            id: 'deposit',
            kind: 'transaction',
            items: [{ status: 'incomplete', data: { from: ADDR, to: ADDR, data: '0x', maxFeePerGas: '1000000' } }],
          },
        ],
      },
    };
    writeQuote('bridge-7', twoSteps);
    await cmds.execute([], api, {}, { quote: 'bridge-7', wallet: 'w', nonce: '20' });
    const nonces = signEvmTransaction.mock.calls.map(c => c[3]);
    expect(nonces).toEqual([20, 21]);
  });
});
