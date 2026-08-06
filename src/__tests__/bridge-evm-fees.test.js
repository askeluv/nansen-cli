import { describe, it, expect, vi, beforeEach } from 'vitest';

const { evmRpcCall } = vi.hoisted(() => ({ evmRpcCall: vi.fn() }));

vi.mock('../trading.js', async (importOriginal) => ({
  ...(await importOriginal()),
  evmRpcCall,
}));

vi.mock('../wallet.js', () => ({
  showWallet: vi.fn(),
  getWalletConfig: vi.fn(() => ({})),
  exportWallet: vi.fn(),
}));

import { resolveEvmStepFees } from '../bridge.js';

const GWEI = 1000000000n;
const MIN_PRIORITY = GWEI / 100n;   // 0.01 gwei, the floor bridge.js applies

// Shaped after a real Relay quote for a Base -> Hyperliquid approve step. Its
// priority fee is the value that stranded a real deposit: Base was including at
// ~0.008 gwei while Relay asked for 0.0011.
const RELAY_QUOTE_FEES = {
  maxFeePerGas: '6600000',          // 0.0066 gwei
  maxPriorityFeePerGas: '1100000',  // 0.0011 gwei
};

function mockBaseFee(wei) {
  evmRpcCall.mockImplementation(async (_chain, method) => {
    if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x' + BigInt(wei).toString(16) };
    if (method === 'eth_gasPrice') return '0x' + (6000000).toString(16);
    throw new Error(`unexpected ${method}`);
  });
}

beforeEach(() => {
  evmRpcCall.mockReset();
});

describe('resolveEvmStepFees', () => {
  it('raises a too-low quote priority fee to the floor', async () => {
    mockBaseFee(5000000n);
    const fees = await resolveEvmStepFees('base', RELAY_QUOTE_FEES);
    expect(BigInt(fees.maxPriorityFeePerGas)).toBe(MIN_PRIORITY);
    // And the cap must cover it.
    expect(BigInt(fees.maxFeePerGas)).toBeGreaterThanOrEqual(BigInt(fees.maxPriorityFeePerGas));
  });

  it('keeps a quote priority fee that already clears the floor', async () => {
    mockBaseFee(5000000n);
    const fees = await resolveEvmStepFees('base', {
      maxFeePerGas: String(GWEI),
      maxPriorityFeePerGas: String(GWEI / 2n),
    });
    expect(BigInt(fees.maxPriorityFeePerGas)).toBe(GWEI / 2n);
  });

  it('lifts the cap to base fee headroom plus priority', async () => {
    const baseFee = 10000000n; // 0.01 gwei
    mockBaseFee(baseFee);
    const fees = await resolveEvmStepFees('base', RELAY_QUOTE_FEES);
    expect(BigInt(fees.maxFeePerGas)).toBe(baseFee * 3n + MIN_PRIORITY);
  });

  it('never returns a cap below the priority fee', async () => {
    // A base fee of 0 would leave the cap at Relay's thin 0.0066 gwei, which is
    // below the floor — nodes reject maxFeePerGas < maxPriorityFeePerGas.
    mockBaseFee(0n);
    const fees = await resolveEvmStepFees('base', RELAY_QUOTE_FEES);
    expect(BigInt(fees.maxFeePerGas)).toBeGreaterThanOrEqual(BigInt(fees.maxPriorityFeePerGas));
  });

  it('still clears the priority fee when the base-fee lookup fails', async () => {
    evmRpcCall.mockRejectedValue(new Error('rpc down'));
    const fees = await resolveEvmStepFees('base', RELAY_QUOTE_FEES);
    expect(BigInt(fees.maxFeePerGas)).toBeGreaterThanOrEqual(BigInt(fees.maxPriorityFeePerGas));
    expect(BigInt(fees.maxPriorityFeePerGas)).toBe(MIN_PRIORITY);
  });

  it('does not raise a quote cap that is already generous', async () => {
    mockBaseFee(5000000n);
    const generous = String(GWEI * 5n);
    const fees = await resolveEvmStepFees('base', {
      maxFeePerGas: generous,
      maxPriorityFeePerGas: String(GWEI),
    });
    expect(fees.maxFeePerGas).toBe(generous);
  });

  // Pre-1559 quote shape: nothing to preserve, so fall back to the node.
  it('falls back to eth_gasPrice when the quote has no fee caps', async () => {
    mockBaseFee(5000000n);
    const fees = await resolveEvmStepFees('base', { gasPrice: '123' });
    expect(fees.gasPrice).toBe('0x' + (6000000).toString(16));
    expect(fees.maxFeePerGas).toBeUndefined();
  });
});
