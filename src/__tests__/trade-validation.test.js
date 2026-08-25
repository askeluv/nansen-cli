import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { validateQuoteInput, fetchNativeBalance, fetchTokenBalance, validateBalance, resolvePercentAmount, validateGasBalance, GASLESS_MIN_TRADE_USD, encodeApproveCalldata, assertValidApprovalSpender, assertQuoteMatchesRequest, assertInputWithinMax, assertSwapCalldataNotBareTransfer, assertSwapOutcome, assertSolanaInstructionsSafe, MAX_UINT256, needsAllowanceRevoke } from '../trade-validation.js';
import { base58Decode, generateSolanaWallet } from '../wallet.js';

describe('validateQuoteInput', () => {
  const validSolana = {
    chain: 'solana',
    from: 'So11111111111111111111111111111111111111112',
    to: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amount: '1000000000',
  };

  const validBase = {
    chain: 'base',
    from: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    amount: '1000000000000000000',
  };

  describe('address format validation', () => {
    it('rejects EVM address on Solana chain', () => {
      expect(() => validateQuoteInput({
        ...validSolana,
        from: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      })).toThrow(/Invalid sell token address for solana/);
    });

    it('rejects Solana address on Base chain', () => {
      expect(() => validateQuoteInput({
        ...validBase,
        from: 'So11111111111111111111111111111111111111112',
      })).toThrow(/Invalid sell token address for base/);
    });

    it('rejects short EVM address', () => {
      expect(() => validateQuoteInput({
        ...validBase,
        to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda029',
      })).toThrow(/Invalid buy token address for base/);
    });

    it('rejects non-base58 Solana address', () => {
      expect(() => validateQuoteInput({
        ...validSolana,
        to: '0OOO1111111111111111111111111111111111112',
      })).toThrow(/Invalid buy token address for solana/);
    });

    it('accepts valid Solana addresses', () => {
      expect(() => validateQuoteInput(validSolana)).not.toThrow();
    });

    it('accepts valid EVM addresses', () => {
      expect(() => validateQuoteInput(validBase)).not.toThrow();
    });

    it('accepts EVM addresses with mixed case (checksum)', () => {
      expect(() => validateQuoteInput({
        ...validBase,
        from: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      })).not.toThrow();
    });
  });

  describe('amount validation', () => {
    it('rejects zero amount', () => {
      expect(() => validateQuoteInput({
        ...validSolana,
        amount: '0',
      })).toThrow(/Invalid amount/);
    });

    it('rejects negative amount', () => {
      expect(() => validateQuoteInput({
        ...validSolana,
        amount: '-100',
      })).toThrow(/Invalid amount/);
    });

    it('rejects non-numeric amount', () => {
      expect(() => validateQuoteInput({
        ...validSolana,
        amount: 'abc',
      })).toThrow(/Invalid amount/);
    });

    it('rejects empty amount', () => {
      expect(() => validateQuoteInput({
        ...validSolana,
        amount: '',
      })).toThrow(/Invalid amount/);
    });

    it('accepts decimal amount', () => {
      expect(() => validateQuoteInput({
        ...validSolana,
        amount: '0.5',
      })).not.toThrow();
    });

    it('accepts large integer amount', () => {
      expect(() => validateQuoteInput({
        ...validSolana,
        amount: '999999999999999',
      })).not.toThrow();
    });
  });

  describe('same token prevention', () => {
    it('rejects same Solana token', () => {
      expect(() => validateQuoteInput({
        ...validSolana,
        to: validSolana.from,
      })).toThrow(/Cannot swap .* for itself/);
    });

    it('rejects same EVM token (case-insensitive)', () => {
      expect(() => validateQuoteInput({
        ...validBase,
        from: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      })).toThrow(/Cannot swap .* for itself/);
    });

    it('allows different tokens', () => {
      expect(() => validateQuoteInput(validSolana)).not.toThrow();
      expect(() => validateQuoteInput(validBase)).not.toThrow();
    });
  });

  describe('chain validation', () => {
    it('rejects unsupported chain', () => {
      expect(() => validateQuoteInput({
        ...validSolana,
        chain: 'polygon',
      })).toThrow(/Unsupported chain/);
    });

    it('is case-insensitive for chain', () => {
      expect(() => validateQuoteInput({
        ...validSolana,
        chain: 'Solana',
      })).not.toThrow();
    });
  });

  describe('USDC/native anchor enforcement', () => {
    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    // Non-native, non-USDC tokens
    const USDT_SOL = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
    const WETH = '0x4200000000000000000000000000000000000006';
    const USDT_BASE = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2';

    // Happy paths
    it('allows SOL → USDT (native on from-side, Solana)', () => {
      expect(() => validateQuoteInput({
        chain: 'solana', from: SOL, to: USDT_SOL, amount: '1000000000',
      })).not.toThrow();
    });

    it('allows USDT → SOL (native on to-side, Solana)', () => {
      expect(() => validateQuoteInput({
        chain: 'solana', from: USDT_SOL, to: SOL, amount: '1000000000',
      })).not.toThrow();
    });

    it('allows SOL → USDC (native + USDC, Solana)', () => {
      expect(() => validateQuoteInput({
        chain: 'solana', from: SOL, to: USDC_SOL, amount: '1000000000',
      })).not.toThrow();
    });

    it('allows USDC → WETH (USDC on from-side, Base)', () => {
      expect(() => validateQuoteInput({
        chain: 'base', from: USDC_BASE, to: WETH, amount: '1000000',
      })).not.toThrow();
    });

    it('allows ETH → USDT (native on from-side, Base)', () => {
      expect(() => validateQuoteInput({
        chain: 'base', from: ETH, to: USDT_BASE, amount: '1000000000000000000',
      })).not.toThrow();
    });

    it('allows cross-chain USDC → USDC (Base → Solana)', () => {
      expect(() => validateQuoteInput({
        chain: 'base', toChain: 'solana', from: USDC_BASE, to: USDC_SOL, amount: '1000000',
      })).not.toThrow();
    });

    // Failure paths
    it('rejects WETH → USDT on Base (neither side is native or USDC)', () => {
      expect(() => validateQuoteInput({
        chain: 'base', from: WETH, to: USDT_BASE, amount: '1000000000000000000',
      })).toThrow(/USDC or the native token/);
    });

    it('rejects BONK → JUP on Solana (neither side is native or USDC)', () => {
      expect(() => validateQuoteInput({
        chain: 'solana', from: BONK, to: JUP, amount: '1000000000',
      })).toThrow(/USDC or the native token/);
    });

    it('rejects cross-chain WETH → BONK (Base → Solana, neither anchor)', () => {
      expect(() => validateQuoteInput({
        chain: 'base', toChain: 'solana', from: WETH, to: BONK, amount: '1000000000000000000',
      })).toThrow(/USDC or the native token/);
    });

    it('allows mixed-case USDC on Base (case-insensitive anchor recognition)', () => {
      expect(() => validateQuoteInput({
        chain: 'base', from: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', to: WETH, amount: '1000000',
      })).not.toThrow();
    });
  });
});

describe('fetchNativeBalance', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns EVM native balance in token units', async () => {
    // 1.5 ETH = 0x14d1120d7b160000 wei
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: '0x14d1120d7b160000' }),
    });

    const balance = await fetchNativeBalance('base', '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    expect(balance).toBeCloseTo(1.5);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns 0 when RPC returns 0x0', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: '0x0' }),
    });

    const balance = await fetchNativeBalance('base', '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    expect(balance).toBe(0);
  });

  it('returns null on RPC failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network error'));

    const balance = await fetchNativeBalance('base', '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    expect(balance).toBeNull();
  });

  it('returns Solana native balance in token units', async () => {
    // 2.5 SOL = 2500000000 lamports
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 2500000000 } }),
    });

    const balance = await fetchNativeBalance('solana', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    expect(balance).toBeCloseTo(2.5);
  });

  it('returns 0 for empty Solana wallet', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 0 } }),
    });

    const balance = await fetchNativeBalance('solana', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    expect(balance).toBe(0);
  });
});

describe('fetchTokenBalance', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns ERC-20 token balance in token units', async () => {
    // 100 USDC = 100000000 (6 decimals) = 0x5f5e100
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: '2.0', id: 1,
        result: '0x0000000000000000000000000000000000000000000000000000000005f5e100',
      }),
    });

    const balance = await fetchTokenBalance(
      'base',
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
      6
    );
    expect(balance).toBeCloseTo(100);
  });

  it('returns 0 when balance is zero', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: '2.0', id: 1,
        result: '0x0000000000000000000000000000000000000000000000000000000000000000',
      }),
    });

    const balance = await fetchTokenBalance(
      'base',
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
      6
    );
    expect(balance).toBe(0);
  });

  it('returns null on RPC failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('timeout'));

    const balance = await fetchTokenBalance(
      'base',
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
      6
    );
    expect(balance).toBeNull();
  });

  it('returns SPL token balance in token units', async () => {
    // 50 USDC = 50000000 (6 decimals)
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: '2.0', id: 1,
        result: {
          value: [{
            account: {
              data: { parsed: { info: { tokenAmount: { amount: '50000000', decimals: 6 } } } },
            },
          }],
        },
      }),
    });

    const balance = await fetchTokenBalance(
      'solana',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      6
    );
    expect(balance).toBeCloseTo(50);
  });

  it('returns 0 when no SPL token account exists', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: '2.0', id: 1,
        result: { value: [] },
      }),
    });

    const balance = await fetchTokenBalance(
      'solana',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      6
    );
    expect(balance).toBe(0);
  });
});

describe('validateBalance', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const SOL_NATIVE = 'So11111111111111111111111111111111111111112';
  const ETH_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

  it('throws when wallet has zero balance of sell token (Solana native)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 0 } }),
    });

    await expect(validateBalance({
      chain: 'solana',
      from: SOL_NATIVE,
      amount: '1',
      amountUnit: 'token',
      walletAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    })).rejects.toThrow(/No SOL balance in wallet/);
  });

  it('throws when amount exceeds balance by more than 2%', async () => {
    // Balance: 1 SOL, trying to sell 1.5 SOL (50% over)
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 1000000000 } }),
    });

    await expect(validateBalance({
      chain: 'solana',
      from: SOL_NATIVE,
      amount: '1.5',
      amountUnit: 'token',
      walletAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    })).rejects.toThrow(/Insufficient balance/);
  });

  it('throws for zero ERC-20 balance', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: '2.0', id: 1,
        result: '0x0000000000000000000000000000000000000000000000000000000000000000',
      }),
    });

    await expect(validateBalance({
      chain: 'base',
      from: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      amount: '100',
      amountUnit: 'token',
      walletAddress: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
      decimals: 6,
    })).rejects.toThrow(/No .* balance in wallet/);
  });

  it('auto-adjusts native SOL and applies fee buffer when amount exceeds balance by ≤2%', async () => {
    // Balance: 10 SOL, amount: 10.15 SOL (1.5% over).
    // Auto-adjust brings it to 10 SOL, then fee buffer reserves 0.005 → 9.995 SOL.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 10000000000 } }),
    });

    const result = await validateBalance({
      chain: 'solana',
      from: SOL_NATIVE,
      amount: '10.15',
      amountUnit: 'token',
      walletAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    });
    expect(Number(result.adjustedAmount)).toBeCloseTo(9.995);
  });

  it('throws when native balance is too small to cover gas reserve even after auto-adjust', async () => {
    // Balance: 0.003 SOL, amount: 0.00301 SOL (0.33% over — within auto-adjust threshold).
    // After auto-adjust to 0.003, fee buffer would require 0.005 → maxSellable ≤ 0 → error.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 3000000 } }),
    });

    await expect(validateBalance({
      chain: 'solana',
      from: SOL_NATIVE,
      amount: '0.00301',
      amountUnit: 'token',
      walletAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    })).rejects.toThrow(/Insufficient .* balance after reserving gas fees/);
  });

  it('subtracts fee buffer when selling ≥95% of native SOL', async () => {
    // Balance: 1 SOL, amount: 0.998 SOL (99.8%) — exceeds maxSellable (1.0 - 0.005 = 0.995)
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 1000000000 } }),
    });

    const result = await validateBalance({
      chain: 'solana',
      from: SOL_NATIVE,
      amount: '0.998',
      amountUnit: 'token',
      walletAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    });
    // adjusted down to maxSellable: 1.0 - 0.005 = 0.995
    expect(Number(result.adjustedAmount)).toBeCloseTo(0.995);
  });

  it('does not produce excess decimal precision after fee buffer subtraction', async () => {
    // Balance: 1.1 SOL — 1.1 - 0.005 = 1.0950000000000002 in naive JS float.
    // Selling 1.1 SOL (100%) exceeds maxSellable, so it gets adjusted down.
    // The adjusted amount must have at most 9 decimal digits (SOL precision).
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 1_100_000_000 } }),
    });

    const result = await validateBalance({
      chain: 'solana',
      from: SOL_NATIVE,
      amount: '1.1',
      amountUnit: 'token',
      walletAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    });
    expect(result.adjustedAmount).toBe('1.095');
    // Ensure no excess fractional digits
    const frac = result.adjustedAmount.split('.')[1] || '';
    expect(frac.length).toBeLessThanOrEqual(9);
  });

  it('subtracts fee buffer when selling ≥95% of native ETH on Base', async () => {
    // Balance: 0.001 ETH, amount: 0.00096 ETH (96%)
    // 0.001 ETH = 0x38d7ea4c68000 wei
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: '0x38d7ea4c68000' }),
    });

    const result = await validateBalance({
      chain: 'base',
      from: ETH_NATIVE,
      amount: '0.00096',
      amountUnit: 'token',
      walletAddress: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
    });
    // 0.001 - 0.00004 = 0.00096, amount equals maxSellable so no adjustment needed
    expect(Number(result.adjustedAmount)).toBeCloseTo(0.00096);
  });

  it('throws when native balance is too low to cover fee buffer', async () => {
    // Balance: 0.003 SOL, amount: 0.003 SOL (100%)
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 3000000 } }),
    });

    await expect(validateBalance({
      chain: 'solana',
      from: SOL_NATIVE,
      amount: '0.003',
      amountUnit: 'token',
      walletAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    })).rejects.toThrow(/Insufficient .* balance after reserving gas fees/);
  });

  it('skips validation when amountUnit is not token', async () => {
    global.fetch = vi.fn();

    const result = await validateBalance({
      chain: 'solana',
      from: SOL_NATIVE,
      amount: '1000000000',
      amountUnit: 'base',
      walletAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    });
    expect(result.adjustedAmount).toBe('1000000000');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('proceeds without error when RPC fails (best-effort)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('RPC down'));

    const result = await validateBalance({
      chain: 'solana',
      from: SOL_NATIVE,
      amount: '1',
      amountUnit: 'token',
      walletAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    });
    expect(result.adjustedAmount).toBe('1');
  });

  it('does not apply fee buffer to non-native tokens', async () => {
    // ERC-20 USDC, balance = 100, selling 96 (96%)
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: '2.0', id: 1,
        result: '0x0000000000000000000000000000000000000000000000000000000005f5e100',
      }),
    });

    const result = await validateBalance({
      chain: 'base',
      from: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      amount: '96',
      amountUnit: 'token',
      walletAddress: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
      decimals: 6,
    });
    expect(result.adjustedAmount).toBe('96');
  });

  it('auto-adjusts ERC-20 amount when it exceeds balance by ≤2%', async () => {
    // Balance: 100 USDC, amount: 101.5 USDC (1.5% over) → adjust to 100
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: '2.0', id: 1,
        result: '0x0000000000000000000000000000000000000000000000000000000005f5e100',
      }),
    });

    const result = await validateBalance({
      chain: 'base',
      from: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      amount: '101.5',
      amountUnit: 'token',
      walletAddress: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
      decimals: 6,
    });
    expect(Number(result.adjustedAmount)).toBeCloseTo(100);
  });
});

describe('quote handler integration', () => {
  it('rejects same-token swap at quote time', async () => {
    const { buildTradingCommands } = await import('../trading.js');
    const commands = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(commands.quote([], null, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'SOL',
      amount: '1000000000',
    })).rejects.toThrow(/Cannot swap .* for itself/);
  });

  it('rejects invalid address format at quote time', async () => {
    const { buildTradingCommands } = await import('../trading.js');
    const commands = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(commands.quote([], null, {}, {
      chain: 'solana',
      from: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      to: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: '1000000000',
    })).rejects.toThrow(/Invalid sell token address/);
  });
});

describe('resolvePercentAmount', () => {
  let origFetch;
  let stderrSpy;
  beforeEach(() => {
    origFetch = global.fetch;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = origFetch;
    stderrSpy.mockRestore();
  });

  it('should calculate 50% of native SOL balance', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 2_000_000_000 } }),
    });

    const result = await resolvePercentAmount({
      chain: 'solana',
      from: 'So11111111111111111111111111111111111111112',
      walletAddress: '11111111111111111111111111111111',
      percentage: 50,
      decimals: 9,
    });
    expect(result).toBe('1');
  });

  it('should return exact balance for 100% of ERC-20 token', async () => {
    const hexBalance = '0x' + (500_000_000n).toString(16).padStart(64, '0');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: hexBalance }),
    });

    const result = await resolvePercentAmount({
      chain: 'base',
      from: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      percentage: 100,
      decimals: 6,
    });
    expect(result).toBe('500');
  });

  it('should apply native fee buffer at 100% SOL', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 1_000_000_000 } }),
    });

    const result = await resolvePercentAmount({
      chain: 'solana',
      from: 'So11111111111111111111111111111111111111112',
      walletAddress: '11111111111111111111111111111111',
      percentage: 100,
      decimals: 9,
    });
    expect(result).toBe('0.995');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Reserving 0.005 SOL for gas')
    );
  });

  it('should not adjust amount when 95% is below fee buffer threshold', async () => {
    const hexBalance = '0x' + (10n ** 18n).toString(16).padStart(64, '0');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: hexBalance }),
    });

    const result = await resolvePercentAmount({
      chain: 'base',
      from: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      percentage: 95,
      decimals: 18,
    });
    expect(result).toBe('0.95');
  });

  it('should reject percentage > 100', async () => {
    await expect(resolvePercentAmount({
      chain: 'solana',
      from: 'So11111111111111111111111111111111111111112',
      walletAddress: '11111111111111111111111111111111',
      percentage: 150,
      decimals: 9,
    })).rejects.toThrow(/Cannot sell more than 100%/);
  });

  it('should reject percentage <= 0', async () => {
    await expect(resolvePercentAmount({
      chain: 'solana',
      from: 'So11111111111111111111111111111111111111112',
      walletAddress: '11111111111111111111111111111111',
      percentage: 0,
      decimals: 9,
    })).rejects.toThrow(/must be between 0 and 100/);
  });

  it('should throw when balance is zero', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 0 } }),
    });

    await expect(resolvePercentAmount({
      chain: 'solana',
      from: 'So11111111111111111111111111111111111111112',
      walletAddress: '11111111111111111111111111111111',
      percentage: 50,
      decimals: 9,
    })).rejects.toThrow(/No .* balance/);
  });

  it('should throw when balance fetch fails (null)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network error'));

    await expect(resolvePercentAmount({
      chain: 'solana',
      from: 'So11111111111111111111111111111111111111112',
      walletAddress: '11111111111111111111111111111111',
      percentage: 50,
      decimals: 9,
    })).rejects.toThrow(/Could not fetch balance/);
  });

  it('should handle fractional percentages like 33.3%', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 3_000_000_000 } }),
    });

    const result = await resolvePercentAmount({
      chain: 'solana',
      from: 'So11111111111111111111111111111111111111112',
      walletAddress: '11111111111111111111111111111111',
      percentage: 33.3,
      decimals: 9,
    });
    expect(result).toBe('0.999');
  });
});

describe('validateGasBalance', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('passes when native balance is above minimum (Solana)', async () => {
    // 0.05 SOL = 50_000_000 lamports
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 50_000_000 } }),
    });

    const result = await validateGasBalance({ chain: 'solana', walletAddress: 'SomeWallet1111111111111111111111111111111111' });
    expect(result.hasSufficientNative).toBe(true);
  });

  it('passes when native balance is above minimum (Base)', async () => {
    // 0.001 ETH in wei
    const weiHex = '0x' + (BigInt('1000000000000000')).toString(16);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: weiHex }),
    });

    const result = await validateGasBalance({ chain: 'base', walletAddress: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4' });
    expect(result.hasSufficientNative).toBe(true);
  });

  it('rejects when gas is below minimum (Solana)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 0 } }),
    });

    await expect(validateGasBalance({
      chain: 'solana',
      walletAddress: 'SomeWallet1111111111111111111111111111111111',
    })).rejects.toThrow(/Insufficient SOL for gas/);
  });

  it('rejects when gas is below minimum (Base)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: '0x0' }),
    });

    await expect(validateGasBalance({
      chain: 'base',
      walletAddress: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
    })).rejects.toThrow(/Insufficient ETH for gas/);
  });

  it('skips validation when RPC fails (best-effort)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('RPC timeout'));

    const result = await validateGasBalance({ chain: 'solana', walletAddress: 'SomeWallet1111111111111111111111111111111111' });
    expect(result.hasSufficientNative).toBe(true);
  });

  it('bypasses gas check when trade value is >= GASLESS_MIN_TRADE_USD (gasless eligible)', async () => {
    // fetch should NOT be called — the check is skipped before any RPC
    global.fetch = vi.fn();

    const result = await validateGasBalance({
      chain: 'solana',
      walletAddress: 'SomeWallet1111111111111111111111111111111111',
      tradeValueUsd: String(GASLESS_MIN_TRADE_USD),
    });
    expect(result.hasSufficientNative).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('bypasses gas check when trade value is well above $10', async () => {
    global.fetch = vi.fn();

    const result = await validateGasBalance({
      chain: 'base',
      walletAddress: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
      tradeValueUsd: '500',
    });
    expect(result.hasSufficientNative).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('still validates gas for trades below GASLESS_MIN_TRADE_USD', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 0 } }),
    });

    await expect(validateGasBalance({
      chain: 'solana',
      walletAddress: 'SomeWallet1111111111111111111111111111111111',
      tradeValueUsd: String(GASLESS_MIN_TRADE_USD - 0.01),
    })).rejects.toThrow(/Insufficient SOL for gas/);
  });

  it('error message includes gasless suggestion when gas is low', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 0 } }),
    });

    await expect(validateGasBalance({
      chain: 'solana',
      walletAddress: 'SomeWallet1111111111111111111111111111111111',
      tradeValueUsd: '5.00',
    })).rejects.toThrow(new RegExp(`\\$${GASLESS_MIN_TRADE_USD}\\+`));
  });
});

describe('quote handler balance validation integration', () => {
  let originalFetch;
  let originalHome;
  let tempDir;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalHome = process.env.HOME;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-tv-'));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.HOME = originalHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects trade when wallet has zero balance', async () => {
    // Create a wallet
    const { createWallet } = await import('../wallet.js');
    createWallet('test-wallet', 'testpassword123');

    // Mock RPC: getBalance returns 0 lamports (zero SOL balance)
    // resolveTokenDecimals for SOL hits KNOWN_DECIMALS cache, no fetch needed
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 0 } }),
    });

    const { buildTradingCommands } = await import('../trading.js');
    const commands = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(commands.quote([], null, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '1',
      'amount-unit': 'token',
      wallet: 'test-wallet',
    })).rejects.toThrow(/No SOL balance in wallet/);
  });
});

describe('quote handler gas validation integration', () => {
  let originalFetch;
  let originalHome;
  let tempDir;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalHome = process.env.HOME;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-gas-'));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.HOME = originalHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects trade when wallet has no gas', async () => {
    const { createWallet } = await import('../wallet.js');
    createWallet('test-wallet', 'testpassword123');

    // Mock fetch to handle multiple calls in sequence:
    // 1. validateBalance: fetchNativeBalance (getBalance) — returns 1 SOL
    // 2. getQuote API call — returns a quote
    // 3. validateGasBalance: fetchNativeBalance (getBalance) — returns 0 SOL (below min gas)
    let getBalanceCallCount = 0;
    global.fetch = vi.fn().mockImplementation((url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : null;

      // RPC calls (getBalance)
      if (body?.method === 'getBalance') {
        getBalanceCallCount++;
        if (getBalanceCallCount === 1) {
          // validateBalance check — wallet has 1 SOL (1e9 lamports)
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 1_000_000_000 } }),
          });
        }
        // validateGasBalance check — wallet has 0 SOL
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 0 } }),
        });
      }

      // Quote API call — getQuote() uses res.text() not res.json()
      if (typeof url === 'string' && url.includes('/quote')) {
        const quoteBody = JSON.stringify({
          success: true,
          quotes: [{
            aggregator: 'test',
            inAmount: '1000000000',
            outAmount: '5000000',
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            inUsdValue: '5.00',
            outUsdValue: '5.00',
          }],
        });
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(quoteBody),
          json: () => Promise.resolve(JSON.parse(quoteBody)),
        });
      }

      // Default: pass through
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });

    const { buildTradingCommands } = await import('../trading.js');
    const commands = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(commands.quote([], null, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '1',
      'amount-unit': 'token',
      wallet: 'test-wallet',
    })).rejects.toThrow(/Insufficient SOL for gas/);
  });
});

// ---------------------------------------------------------------------------
// ERC-20 approval calldata hardening
//
// A swap quote supplies the approval spender and (via the input amount) the
// allowance verbatim. These are concatenated into approve() calldata, so an
// over-length spender or an unbounded amount could reshape the ABI word layout
// and turn a scoped approval into approve(attacker, MAX). encodeApproveCalldata
// is the single choke point every signing path uses; it must fail closed.
// ---------------------------------------------------------------------------

const VALID_SPENDER = '0x1111111254eeb25477b68fb85ed929f73a960582';

// Decode approve(address,uint256) calldata into its two 32-byte ABI words.
function decodeApprove(data) {
  expect(data.slice(0, 10)).toBe('0x095ea7b3');
  const body = data.slice(10);
  expect(body.length).toBe(128); // exactly two 32-byte words
  const spenderWord = body.slice(0, 64);
  const amountWord = body.slice(64, 128);
  return {
    spender: '0x' + spenderWord.slice(24), // low 20 bytes of the first word
    spenderWord,
    amount: BigInt('0x' + amountWord),
  };
}

describe('assertValidApprovalSpender', () => {
  it('accepts a well-formed 20-byte address', () => {
    expect(() => assertValidApprovalSpender(VALID_SPENDER)).not.toThrow();
  });

  it('rejects empty / undefined / zero address', () => {
    expect(() => assertValidApprovalSpender('')).toThrow(/empty or the zero address/i);
    expect(() => assertValidApprovalSpender(undefined)).toThrow(/empty or the zero address/i);
    expect(() => assertValidApprovalSpender('0x0000000000000000000000000000000000000000')).toThrow(/empty or the zero address/i);
  });

  it('rejects an over-length spender (the calldata-shifting attack vector)', () => {
    // 0x + 128 hex chars: a crafted value that, left unchecked, would occupy two
    // ABI words — attacker in word 0, MAX in word 1 — with the scoped amount
    // pushed into ignored trailing calldata.
    const attacker = '22'.repeat(20);
    const oversized = '0x' + '00'.repeat(12) + attacker + 'f'.repeat(64);
    expect(() => assertValidApprovalSpender(oversized)).toThrow(/not a valid 20-byte address/i);
  });

  it('rejects a too-short spender and non-hex chars', () => {
    expect(() => assertValidApprovalSpender('0x1234')).toThrow(/not a valid 20-byte address/i);
    expect(() => assertValidApprovalSpender('0xRouterApproval')).toThrow(/not a valid 20-byte address/i);
  });
});

describe('encodeApproveCalldata', () => {
  it('encodes a scoped approval to exactly 68 bytes with correct words', () => {
    const data = encodeApproveCalldata(VALID_SPENDER, 1000000n);
    expect(data.length).toBe(2 + 8 + 64 + 64); // 0x + selector + 2 words
    const { spender, amount } = decodeApprove(data);
    expect(spender.toLowerCase()).toBe(VALID_SPENDER.toLowerCase());
    expect(amount).toBe(1000000n);
  });

  it('refuses an over-length spender rather than producing approve(attacker, MAX)', () => {
    // The core exploit: a 130-char spender whose bytes decode to
    // (attacker, MAX_UINT256), with the intended amount as trailing calldata.
    const attacker = '0x' + '00'.repeat(12) + '22'.repeat(20);
    const craftedSpender = attacker + 'f'.repeat(64); // 0x + 128 hex chars
    expect(() => encodeApproveCalldata(craftedSpender, 1000000n)).toThrow(/not a valid 20-byte address/i);
  });

  it('refuses MAX_UINT256 (unlimited) and anything above it', () => {
    expect(() => encodeApproveCalldata(VALID_SPENDER, MAX_UINT256)).toThrow(/unlimited/i);
    expect(() => encodeApproveCalldata(VALID_SPENDER, MAX_UINT256 + 1n)).toThrow(/unlimited/i);
    // Just below MAX is allowed (bounded) and still encodes to 68 bytes.
    const data = encodeApproveCalldata(VALID_SPENDER, MAX_UINT256 - 1n);
    expect(data.length).toBe(138);
    expect(decodeApprove(data).amount).toBe(MAX_UINT256 - 1n);
  });

  it('refuses zero, negative, and non-integer amounts', () => {
    expect(() => encodeApproveCalldata(VALID_SPENDER, 0n)).toThrow(/must be positive/i);
    expect(() => encodeApproveCalldata(VALID_SPENDER, -5n)).toThrow(/must be positive/i);
    expect(() => encodeApproveCalldata(VALID_SPENDER, '1.5')).toThrow(/not an integer/i);
    expect(() => encodeApproveCalldata(VALID_SPENDER, '1.5e6')).toThrow(/not an integer/i);
  });

  it('allows zero only for explicit revoke approvals', () => {
    const data = encodeApproveCalldata(VALID_SPENDER, 0n, { allowZero: true });
    expect(decodeApprove(data).amount).toBe(0n);
  });

  it('enforces the request-intent cap (maxAllowance)', () => {
    // exactly at the cap is fine
    expect(() => encodeApproveCalldata(VALID_SPENDER, 1000n, { maxAllowance: 1000n })).not.toThrow();
    // one unit over the cap is refused
    expect(() => encodeApproveCalldata(VALID_SPENDER, 1001n, { maxAllowance: 1000n })).toThrow(/exceeds the request/i);
  });
});

describe('needsAllowanceRevoke', () => {
  it('does not revoke zero or sufficient scoped allowances', () => {
    expect(needsAllowanceRevoke(0n, 1000n)).toBe(false);
    expect(needsAllowanceRevoke(1000n, 1000n)).toBe(false);
  });

  it('uses a strict more-than-10x boundary', () => {
    expect(needsAllowanceRevoke(10000n, 1000n)).toBe(false);
    expect(needsAllowanceRevoke(10001n, 1000n)).toBe(true);
  });

  it('ignores invalid approval amounts defensively', () => {
    expect(needsAllowanceRevoke(1000000n, 0n)).toBe(false);
    expect(needsAllowanceRevoke(1000000n, -1n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Quote vs. request-intent revalidation
//
// saveQuote persists what the user asked for; the execute path revalidates the
// API's quote against it so a compromised quote can't inflate the input (and
// therefore the scoped approval and native value) past the user's intent.
// ---------------------------------------------------------------------------
describe('assertQuoteMatchesRequest', () => {
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

  const request = {
    chain: 'base',
    walletAddress: '0xWallet',
    fromToken: USDC,
    toToken: USDT,
    swapMode: 'exactIn',
    amount: '1000000',
  };
  const okQuote = { inputMint: USDC, outputMint: USDT, inputAmount: '1000000', inAmount: '1000000', outAmount: '990000' };

  it('passes when the quote matches the request', () => {
    expect(assertQuoteMatchesRequest(request, okQuote, { chain: 'base' })).toEqual({ skipped: false });
  });

  it('skips (does not throw) when no request intent was persisted', () => {
    expect(assertQuoteMatchesRequest(undefined, okQuote, { chain: 'base' })).toEqual({ skipped: true });
  });

  it('rejects an inflated exactIn input (the core spend-binding)', () => {
    const inflated = { ...okQuote, inputAmount: '5000000', inAmount: '5000000' };
    expect(() => assertQuoteMatchesRequest(request, inflated, { chain: 'base' })).toThrow(/input amount .* does not match/i);
  });

  it('is case-insensitive on EVM token addresses', () => {
    const mixed = { ...okQuote, inputMint: USDC.toLowerCase(), outputMint: USDT.toLowerCase() };
    expect(() => assertQuoteMatchesRequest(request, mixed, { chain: 'base' })).not.toThrow();
  });

  it('rejects a swapped-in sell token', () => {
    const poisoned = { ...okQuote, inputMint: USDT };
    expect(() => assertQuoteMatchesRequest(request, poisoned, { chain: 'base' })).toThrow(/sell token .* does not match/i);
  });

  it('rejects a mismatched buy token', () => {
    const poisoned = { ...okQuote, outputMint: '0xBEEF00000000000000000000000000000000BEEF' };
    expect(() => assertQuoteMatchesRequest(request, poisoned, { chain: 'base' })).toThrow(/buy token .* does not match/i);
  });

  it('rejects a chain mismatch', () => {
    expect(() => assertQuoteMatchesRequest(request, okQuote, { chain: 'solana' })).toThrow(/chain .* does not match/i);
  });

  it('binds the requested output for exactOut (at-least, not exact)', () => {
    // exactOut needs a persisted max input (the sole input cap) or it fails closed.
    // slippage:0 isolates this test from the input buffer — input==cap passes.
    const req = { ...request, swapMode: 'exactOut', amount: '990000', maxInputAmount: '1000000' };
    expect(() => assertQuoteMatchesRequest(req, okQuote, { chain: 'base', slippage: 0 })).not.toThrow();
    // MORE output than requested is upside (input is capped separately) — allowed.
    const moreOut = { ...okQuote, outAmount: '990001' };
    expect(() => assertQuoteMatchesRequest(req, moreOut, { chain: 'base', slippage: 0 })).not.toThrow();
    // LESS output than requested is a shortfall — rejected.
    const shortfall = { ...okQuote, outAmount: '989999' };
    expect(() => assertQuoteMatchesRequest(req, shortfall, { chain: 'base', slippage: 0 })).toThrow(/less than the requested output/i);
  });

  it('measures the exactOut spend ceiling against the slippage-buffered approval', () => {
    // Regression: a quote whose RAW input equals the cap still overflows it once
    // the exactOut slippage buffer is applied (1,000,000 @ 3% → 1,030,000). It
    // must be refused here rather than passing and then being rejected by the
    // approval encoder at signing time.
    const req = { ...request, swapMode: 'exactOut', amount: '990000', maxInputAmount: '1000000' };
    expect(() => assertQuoteMatchesRequest(req, okQuote, { chain: 'base', slippage: 0.03 }))
      .toThrow(/exceeds your maximum input/i);
    // Raise the cap to cover the buffered approval and the same quote passes.
    const roomy = { ...req, maxInputAmount: '1030000' };
    expect(() => assertQuoteMatchesRequest(roomy, okQuote, { chain: 'base', slippage: 0.03 })).not.toThrow();
  });

  it('binds the signer to the wallet the quote was built for', () => {
    const req = { ...request, walletAddress: '0xAaAa000000000000000000000000000000000001' };
    // Same address (case-insensitive on EVM) passes; a different signer is refused.
    expect(() => assertQuoteMatchesRequest(req, okQuote, { chain: 'base', walletAddress: '0xaaaa000000000000000000000000000000000001' })).not.toThrow();
    expect(() => assertQuoteMatchesRequest(req, okQuote, { chain: 'base', walletAddress: '0xBBBB000000000000000000000000000000000002' })).toThrow(/built for wallet .* but the signer is/i);
    // No signer supplied (address unknown) → the check is skipped, not failed.
    expect(() => assertQuoteMatchesRequest(req, okQuote, { chain: 'base' })).not.toThrow();
  });

  it('fails closed on an exactOut quote with no persisted maximum input', () => {
    const req = { ...request, swapMode: 'exactOut', amount: '990000' }; // no maxInputAmount
    expect(() => assertQuoteMatchesRequest(req, okQuote, { chain: 'base' })).toThrow(/no persisted maximum input/i);
  });

  it('rejects an exactOut quote whose input exceeds the persisted maximum', () => {
    const req = { ...request, swapMode: 'exactOut', amount: '990000', maxInputAmount: '1000000' };
    // Requested output is correct, but the API demands a larger input than the cap.
    const overpay = { ...okQuote, inputAmount: '1500000', inAmount: '1500000' };
    expect(() => assertQuoteMatchesRequest(req, overpay, { chain: 'base' })).toThrow(/exceeds your maximum input/i);
  });

  it('enforces the maximum input for exactIn too (defense in depth)', () => {
    // request.amount already binds exactIn, but a tighter maxInputAmount still holds.
    const req = { ...request, maxInputAmount: '500000' };
    expect(() => assertQuoteMatchesRequest(req, okQuote, { chain: 'base' })).toThrow(/exceeds your maximum input/i);
  });

  it('fails closed when a bound field is missing from the quote', () => {
    // Missing sell token, buy token, or the bound amount must reject, not skip.
    expect(() => assertQuoteMatchesRequest(request, { ...okQuote, inputMint: undefined }, { chain: 'base' }))
      .toThrow(/missing the sell-token/i);
    expect(() => assertQuoteMatchesRequest(request, { ...okQuote, outputMint: undefined }, { chain: 'base' }))
      .toThrow(/missing the buy-token/i);
    expect(() => assertQuoteMatchesRequest(request, { ...okQuote, inputAmount: undefined, inAmount: undefined }, { chain: 'base' }))
      .toThrow(/missing the input amount/i);
    const outReq = { ...request, swapMode: 'exactOut', amount: '990000', maxInputAmount: '1000000' };
    expect(() => assertQuoteMatchesRequest(outReq, { ...okQuote, outAmount: undefined, outputAmount: undefined }, { chain: 'base' }))
      .toThrow(/missing the output amount/i);
  });

  it('compares the output token with the destination chain rules for cross-chain quotes', () => {
    // EVM→Solana: source chain is 'base' but the output token is a case-sensitive
    // Solana base58 address, so it must be compared with Solana (exact) rules,
    // not source-chain (EVM, case-insensitive) rules.
    const SOL_TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const xchain = {
      chain: 'base', toChain: 'solana', walletAddress: '0xWallet',
      fromToken: USDC, toToken: SOL_TOKEN, swapMode: 'exactIn', amount: '1000000',
    };
    const q = { inputMint: USDC, outputMint: SOL_TOKEN, inputAmount: '1000000', inAmount: '1000000' };
    // Exact match on the Solana output token passes.
    expect(() => assertQuoteMatchesRequest(xchain, q, { chain: 'base' })).not.toThrow();
    // A case-mangled Solana address is a *different* token and must be rejected
    // (would have wrongly passed under source-chain case-insensitive rules).
    const mangled = { ...q, outputMint: SOL_TOKEN.toLowerCase() };
    expect(() => assertQuoteMatchesRequest(xchain, mangled, { chain: 'base' })).toThrow(/buy token .* does not match/i);
  });

  it('treats the two native-SOL spellings as the same asset (cross-chain destination)', () => {
    // Regression: `--to SOL` resolves to the wrapped-SOL mint (stored as the
    // request intent), but a Relay bridge quote names native SOL as the System
    // Program sentinel. They are the same asset and must not be rejected as a
    // token mismatch, which previously blocked every bridge into native SOL.
    const WSOL = 'So11111111111111111111111111111111111111112';
    const NATIVE_SOL_SENTINEL = '11111111111111111111111111111111';
    const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const xchain = {
      chain: 'base', toChain: 'solana', walletAddress: '0xWallet',
      fromToken: USDC, toToken: WSOL, swapMode: 'exactIn', amount: '1000000',
    };
    const q = { inputMint: USDC, outputMint: NATIVE_SOL_SENTINEL, inputAmount: '1000000', inAmount: '1000000' };
    // WSOL requested, native-sentinel delivered — same asset, passes.
    expect(() => assertQuoteMatchesRequest(xchain, q, { chain: 'base' })).not.toThrow();
    // Reverse spelling (sentinel requested, WSOL delivered) also passes.
    const xchain2 = { ...xchain, toToken: NATIVE_SOL_SENTINEL };
    const q2 = { ...q, outputMint: WSOL };
    expect(() => assertQuoteMatchesRequest(xchain2, q2, { chain: 'base' })).not.toThrow();
    // A genuinely different Solana token is still rejected.
    const qBad = { ...q, outputMint: USDC_SOL };
    expect(() => assertQuoteMatchesRequest(xchain, qBad, { chain: 'base' })).toThrow(/buy token .* does not match/i);
  });
});

describe('assertInputWithinMax', () => {
  const base = { inputAmount: '1000000', inAmount: '1000000' };

  it('is a no-op for exactIn with no cap (request.amount already binds it)', () => {
    expect(() => assertInputWithinMax({ swapMode: 'exactIn' }, base)).not.toThrow();
    expect(() => assertInputWithinMax(undefined, base)).not.toThrow();
  });

  it('fails closed for exactOut without a persisted cap', () => {
    expect(() => assertInputWithinMax({ swapMode: 'exactOut' }, base)).toThrow(/no persisted maximum input/i);
  });

  it('passes when the spend is at or below the cap and rejects above it', () => {
    // slippage:0 → exactOut buffer is a no-op, so the raw input is the spend.
    expect(() => assertInputWithinMax({ swapMode: 'exactOut', maxInputAmount: '1000000' }, base, 0)).not.toThrow();
    expect(() => assertInputWithinMax({ swapMode: 'exactOut', maxInputAmount: '999999' }, base, 0)).toThrow(/exceeds your maximum input/i);
  });

  it('bounds the exactOut slippage-buffered approval, not the raw input', () => {
    // Regression (exactOut ERC-20 + --max-input): raw input 1,000,000 at 3%
    // slippage needs a 1,030,000 approval. A 1,000,000 cap must reject it here
    // so it never reaches — and is rejected by — the approval encoder.
    expect(() => assertInputWithinMax({ swapMode: 'exactOut', maxInputAmount: '1000000' }, base, 0.03))
      .toThrow(/approval of 1030000 base units .* exceeds your maximum input \(1000000\)/i);
    // A cap that covers the buffered approval passes.
    expect(() => assertInputWithinMax({ swapMode: 'exactOut', maxInputAmount: '1030000' }, base, 0.03)).not.toThrow();
    // With no slippage supplied it defaults to 3% (matching approvalAmountForSwap
    // and the approval the execute path builds), so input==cap still overflows.
    expect(() => assertInputWithinMax({ swapMode: 'exactOut', maxInputAmount: '1000000' }, base))
      .toThrow(/exceeds your maximum input/i);
  });

  it('does not buffer exactIn — the raw input is the spend ceiling', () => {
    expect(() => assertInputWithinMax({ swapMode: 'exactIn', maxInputAmount: '1000000' }, base, 0.03)).not.toThrow();
    expect(() => assertInputWithinMax({ swapMode: 'exactIn', maxInputAmount: '999999' }, base, 0.03)).toThrow(/exceeds your maximum input/i);
  });

  it('fails closed on a missing or non-integer quote input when a cap is set', () => {
    expect(() => assertInputWithinMax({ maxInputAmount: '1000000' }, {})).toThrow(/missing the input amount/i);
    expect(() => assertInputWithinMax({ maxInputAmount: '1000000' }, { inAmount: '1.5' })).toThrow(/not an integer/i);
  });
});

// ---------------------------------------------------------------------------
// Same-chain swap-calldata shape guard
//
// A legitimate same-chain swap's outer call is a router method; a bare ERC-20
// transfer/approve/transferFrom as the swap tx is a disguised drain payload.
// (Callers scope this to same-chain swaps — bridges are excluded.)
// ---------------------------------------------------------------------------
describe('assertSwapCalldataNotBareTransfer', () => {
  it('rejects a bare transfer / approve / transferFrom as the swap calldata', () => {
    // transfer(address,uint256)
    expect(() => assertSwapCalldataNotBareTransfer('0xa9059cbb' + '0'.repeat(128))).toThrow(/bare ERC-20 transfer/i);
    // approve(address,uint256)
    expect(() => assertSwapCalldataNotBareTransfer('0x095ea7b3' + '0'.repeat(128))).toThrow(/bare ERC-20 approve/i);
    // transferFrom(address,address,uint256)
    expect(() => assertSwapCalldataNotBareTransfer('0x23b872dd' + '0'.repeat(192))).toThrow(/bare ERC-20 transferFrom/i);
  });

  it('is case-insensitive on the selector', () => {
    expect(() => assertSwapCalldataNotBareTransfer('0xA9059CBB' + '0'.repeat(128))).toThrow(/bare ERC-20 transfer/i);
  });

  it('allows a router/aggregator swap selector', () => {
    // e.g. an aggregator execute/swap selector — not on the denylist.
    expect(() => assertSwapCalldataNotBareTransfer('0x12aa3caf' + '0'.repeat(200))).not.toThrow();
    expect(() => assertSwapCalldataNotBareTransfer('0xdeadbeef' + '0'.repeat(8))).not.toThrow();
  });

  it('no-ops on absent or too-short calldata (e.g. a plain value transfer)', () => {
    expect(() => assertSwapCalldataNotBareTransfer(undefined)).not.toThrow();
    expect(() => assertSwapCalldataNotBareTransfer('')).not.toThrow();
    expect(() => assertSwapCalldataNotBareTransfer('0x')).not.toThrow();
    expect(() => assertSwapCalldataNotBareTransfer('0xa905')).not.toThrow(); // < 4 bytes
  });
});

describe('assertSwapOutcome', () => {
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
  const ROUTER = '0x57df6092665eb6058def53f94734a338a50f2e5f';
  const ATTACKER = '0x00000000000000000000000000000000deadbeef';
  const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

  // exactIn: sell 1,000,000 USDC for DAI, quoted 1,000,000 out, 3% slippage.
  const exactInRequest = {
    chain: 'base', walletAddress: '0xwallet', fromToken: USDC, toToken: DAI,
    swapMode: 'exactIn', amount: '1000000', maxInputAmount: '1000000',
  };
  const exactInQuote = { inputMint: USDC, outputMint: DAI, inAmount: '1000000', outAmount: '1000000' };

  it('passes a benign exactIn swap within cap and above min output', () => {
    const sim = { deltas: { [USDC]: -1000000n, [DAI]: 1000000n }, approvals: [] };
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, sim, { slippage: 0.03, expectedSpenders: [ROUTER] }))
      .not.toThrow();
  });

  it('accepts a benign exactIn output within the slippage floor', () => {
    // 3% slippage floor on 1,000,000 = 970,000; 980,000 received is acceptable.
    const sim = { deltas: { [USDC]: -1000000n, [DAI]: 980000n }, approvals: [] };
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, sim, { slippage: 0.03 })).not.toThrow();
  });

  it('rejects an input outflow exceeding maxInputAmount (assertion 1)', () => {
    const sim = { deltas: { [USDC]: -1000001n, [DAI]: 1000000n }, approvals: [] };
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, sim, {}))
      .toThrow(/SWAP_OUTCOME_MISMATCH[\s\S]*maximum input/i);
  });

  it('rejects an output below the minimum acceptable (assertion 2)', () => {
    const sim = { deltas: { [USDC]: -1000000n, [DAI]: 900000n }, approvals: [] }; // below 970,000 floor
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, sim, { slippage: 0.03 }))
      .toThrow(/SWAP_OUTCOME_MISMATCH[\s\S]*minimum acceptable output/i);
  });

  it('rejects a sibling-token drain (assertion 3)', () => {
    // Input + output are correct, but a THIRD token also leaves the wallet —
    // the pre-existing-allowance drain the static checks cannot catch.
    const sim = {
      deltas: { [USDC]: -1000000n, [DAI]: 1000000n, '0xaaaa000000000000000000000000000000000001': -42n },
      approvals: [],
    };
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, sim, {}))
      .toThrow(/SWAP_OUTCOME_MISMATCH[\s\S]*other than the one you are selling/i);
  });

  it('rejects an exactIn quote with a zero quoted output', () => {
    // outAmount "0" makes minOut 0, so a zero-output sim would pass assertion 2
    // (0 < 0 is false). exactIn has no upstream positive-output guard.
    const quote = { inputMint: USDC, outputMint: DAI, inAmount: '1000000', outAmount: '0' };
    const sim = { deltas: { [USDC]: -1000000n }, approvals: [] };
    expect(() => assertSwapOutcome(exactInRequest, quote, sim, { slippage: 0.03 }))
      .toThrow(/SWAP_OUTCOME_MISMATCH[\s\S]*non-positive output amount/i);
  });

  it('rejects an exactIn quote with a negative quoted output', () => {
    // A negative outAmount makes minOut negative, so a sim receiving nothing (or
    // even losing the output token) would pass assertion 2. Fail closed instead.
    const quote = { inputMint: USDC, outputMint: DAI, inAmount: '1000000', outAmount: '-5' };
    const sim = { deltas: { [USDC]: -1000000n }, approvals: [] };
    expect(() => assertSwapOutcome(exactInRequest, quote, sim, { slippage: 0.03 }))
      .toThrow(/SWAP_OUTCOME_MISMATCH[\s\S]*non-positive output amount/i);
  });

  it('fails closed when input and output tokens are the same', () => {
    // Assertion 3 skips the input token, so a same-token quote could hide a
    // drain of the "output" token. Refuse before the assertions run.
    const req = { ...exactInRequest, toToken: USDC };
    const quote = { inputMint: USDC, outputMint: USDC, inAmount: '1000000', outAmount: '1000000' };
    const sim = { deltas: { [USDC]: -1000000n }, approvals: [] };
    expect(() => assertSwapOutcome(req, quote, sim, {}))
      .toThrow(/SWAP_OUTCOME_MISMATCH[\s\S]*input and output tokens are the same/i);
  });

  it('fails closed when an NFT leaves the wallet (assertion 3b)', () => {
    // Input + output are correct, but the sim also reports an ERC-721/1155 leaving
    // the wallet — invisible to the fungible-only deltas map. A swap must not move
    // any NFT, so refuse.
    const sim = {
      deltas: { [USDC]: -1000000n, [DAI]: 1000000n },
      approvals: [],
      nftOut: [{ standard: 'ERC-721', token: '0x000000000000000000000000000000000000abcd' }],
    };
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, sim, {}))
      .toThrow(/SWAP_OUTCOME_MISMATCH[\s\S]*non-fungible asset/i);
  });

  it('fails closed when the swap grants an NFT approval (assertion 3c)', () => {
    // A single-NFT Approval folds in as a zero-amount "revoke" and an
    // ApprovalForAll is not an ERC-20 Approval, so neither reaches assertion 4.
    // Both grant an operator the ability to move the NFT out after the swap.
    const base = { deltas: { [USDC]: -1000000n, [DAI]: 1000000n }, approvals: [] };
    const nft = '0x000000000000000000000000000000000000abcd';
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, { ...base, nftApprovals: [{ standard: 'ERC-721', token: nft, operator: ATTACKER }] }, {}))
      .toThrow(/SWAP_OUTCOME_MISMATCH[\s\S]*non-fungible approval/i);
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, { ...base, nftApprovals: [{ standard: 'ERC-721/1155 (all)', token: nft, operator: ATTACKER }] }, {}))
      .toThrow(/SWAP_OUTCOME_MISMATCH[\s\S]*non-fungible approval/i);
  });

  it('caps the slippage floor at 50%, so 100% slippage cannot neuter assertion 2', () => {
    // --slippage 1 (100%, accepted upstream) would make minOut 0, letting a swap
    // deliver nothing. The floor is capped at 50% of quoted regardless.
    const zeroOut = { deltas: { [USDC]: -1000000n }, approvals: [] }; // no DAI received
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, zeroOut, { slippage: 1 }))
      .toThrow(/SWAP_OUTCOME_MISMATCH[\s\S]*minimum acceptable output/i);
    // 600,000 received is above the 50% floor (500,000) even though it is below
    // the 970,000 a 3% floor would demand — 100% slippage still allows the swap.
    const halfOut = { deltas: { [USDC]: -1000000n, [DAI]: 600000n }, approvals: [] };
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, halfOut, { slippage: 1 })).not.toThrow();
    // Just below the 50% floor fails.
    const belowFloor = { deltas: { [USDC]: -1000000n, [DAI]: 499999n }, approvals: [] };
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, belowFloor, { slippage: 1 }))
      .toThrow(/SWAP_OUTCOME_MISMATCH[\s\S]*minimum acceptable output/i);
  });

  it('rejects an approval to an unexpected spender (assertion 4)', () => {
    const sim = {
      deltas: { [USDC]: -1000000n, [DAI]: 1000000n },
      approvals: [{ token: USDC, spender: ATTACKER, amount: 500000n }],
    };
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, sim, { expectedSpenders: [ROUTER] }))
      .toThrow(/SWAP_OUTCOME_MISMATCH[\s\S]*unexpected spender/i);
  });

  it('allows an approval to an expected spender', () => {
    const sim = {
      deltas: { [USDC]: -1000000n, [DAI]: 1000000n },
      approvals: [{ token: USDC, spender: ROUTER.toUpperCase(), amount: 500000n }], // case-insensitive
    };
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, sim, { expectedSpenders: [ROUTER] })).not.toThrow();
  });

  it('allows a revoke (approve to 0) to any spender', () => {
    const sim = {
      deltas: { [USDC]: -1000000n, [DAI]: 1000000n },
      approvals: [{ token: USDC, spender: ATTACKER, amount: 0n }],
    };
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, sim, { expectedSpenders: [ROUTER] })).not.toThrow();
  });

  it('excludes gas for a native input (log-based deltas)', () => {
    // Native sell of 0.0015 ETH; the sim delta is exactly the value moved, no gas.
    const req = { ...exactInRequest, fromToken: NATIVE, amount: '1500000000000000', maxInputAmount: '1500000000000000' };
    const quote = { inputMint: NATIVE, outputMint: USDC, inAmount: '1500000000000000', outAmount: '5000000' };
    const sim = { deltas: { [NATIVE]: -1500000000000000n, [USDC]: 5000000n }, approvals: [] };
    expect(() => assertSwapOutcome(req, { ...quote }, sim, {})).not.toThrow();
  });

  it('enforces exactOut minimum output = requested output', () => {
    const req = { ...exactInRequest, swapMode: 'exactOut', amount: '1000000', maxInputAmount: '1100000' };
    const quote = { inputMint: USDC, outputMint: DAI, inAmount: '1050000', outAmount: '1000000' };
    const good = { deltas: { [USDC]: -1050000n, [DAI]: 1000000n }, approvals: [] };
    expect(() => assertSwapOutcome(req, quote, good, {})).not.toThrow();
    const short = { deltas: { [USDC]: -1050000n, [DAI]: 999999n }, approvals: [] };
    expect(() => assertSwapOutcome(req, quote, short, {})).toThrow(/SWAP_OUTCOME_MISMATCH/i);
  });

  it('rejects an exactOut request with a non-positive requested output', () => {
    // amount "0" makes minOut 0, so a zero-output sim would pass assertion 2
    // (outputDelta >= 0). Mirror the exactIn guard and fail closed.
    const req = { ...exactInRequest, swapMode: 'exactOut', amount: '0', maxInputAmount: '1100000' };
    const quote = { inputMint: USDC, outputMint: DAI, inAmount: '1050000', outAmount: '0' };
    const sim = { deltas: { [USDC]: -1050000n }, approvals: [] };
    expect(() => assertSwapOutcome(req, quote, sim, {}))
      .toThrow(/SWAP_OUTCOME_MISMATCH[\s\S]*non-positive output amount/i);
  });

  it('tolerates a sub-threshold non-input outflow when a dust threshold is set', () => {
    const sim = {
      deltas: { [USDC]: -1000000n, [DAI]: 1000000n, '0xaaaa000000000000000000000000000000000001': -3n },
      approvals: [],
    };
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, sim, { siblingDustThreshold: 5n })).not.toThrow();
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, sim, { siblingDustThreshold: 2n })).toThrow(/SWAP_OUTCOME_MISMATCH/i);
  });

  it('fails closed when the request has no maximum input', () => {
    const req = { ...exactInRequest, maxInputAmount: undefined };
    const sim = { deltas: { [USDC]: -1000000n, [DAI]: 1000000n }, approvals: [] };
    expect(() => assertSwapOutcome(req, exactInQuote, sim, {})).toThrow(/SWAP_OUTCOME_MISMATCH[\s\S]*maximum input/i);
  });

  it('fails closed on a corrupt (non-integer) simulated delta', () => {
    const sim = { deltas: { [USDC]: 'not-a-number' }, approvals: [] };
    expect(() => assertSwapOutcome(exactInRequest, exactInQuote, sim, {})).toThrow(/SWAP_OUTCOME_MISMATCH/i);
  });
});

describe('assertSolanaInstructionsSafe', () => {
  const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

  function encodeCompactU16(value) {
    if (value < 0x80) return Buffer.from([value]);
    if (value < 0x4000) return Buffer.from([(value & 0x7f) | 0x80, (value >> 7) & 0x7f]);
    return Buffer.from([(value & 0x7f) | 0x80, ((value >> 7) & 0x7f) | 0x80, (value >> 14) & 0x03]);
  }

  // Minimal legacy-message builder — accountKeys[0] is always the wallet
  // (fee payer / sole signer) unless a test overrides the ordering directly.
  function buildTransaction({ accountKeys, instructions }) {
    const parts = [Buffer.from([1, 0, accountKeys.length - 1])]; // 1 signer, that signer is writable
    parts.push(encodeCompactU16(accountKeys.length));
    for (const k of accountKeys) parts.push(base58Decode(k));
    parts.push(base58Decode(accountKeys[0])); // recentBlockhash placeholder — any 32 bytes
    parts.push(encodeCompactU16(instructions.length));
    for (const ix of instructions) {
      parts.push(Buffer.from([ix.programIdIndex]));
      parts.push(encodeCompactU16(ix.accountIndexes.length));
      for (const idx of ix.accountIndexes) parts.push(Buffer.from([idx]));
      parts.push(encodeCompactU16(ix.data.length));
      parts.push(ix.data);
    }
    const messageBytes = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), messageBytes]).toString('base64');
  }

  function computeBudgetSetLimit(units) {
    const data = Buffer.alloc(5);
    data[0] = 2;
    data.writeUInt32LE(units, 1);
    return data;
  }
  function computeBudgetSetPrice(microLamports) {
    const data = Buffer.alloc(9);
    data[0] = 3;
    data.writeBigUInt64LE(BigInt(microLamports), 1);
    return data;
  }

  it('passes a benign transaction with no SPL Token or ComputeBudget instructions', () => {
    const wallet = generateSolanaWallet().address;
    const programId = generateSolanaWallet().address;
    const tx = buildTransaction({
      accountKeys: [wallet, programId],
      instructions: [{ programIdIndex: 1, accountIndexes: [0], data: Buffer.from([0x01]) }],
    });
    expect(() => assertSolanaInstructionsSafe(tx, { walletAddress: wallet })).not.toThrow();
  });

  it('fails closed when no wallet address is provided rather than silently passing', () => {
    // An Approve authorized by the (unknown) signer must not slip through just
    // because walletAddress is missing — the check would otherwise compare
    // against undefined and never fire.
    const wallet = generateSolanaWallet().address;
    const sourceAccount = generateSolanaWallet().address;
    const delegate = generateSolanaWallet().address;
    const tx = buildTransaction({
      accountKeys: [wallet, sourceAccount, delegate, TOKEN_PROGRAM],
      instructions: [{ programIdIndex: 3, accountIndexes: [1, 2, 0], data: Buffer.from([4]) }],
    });
    expect(() => assertSolanaInstructionsSafe(tx, {})).toThrow(/without the signing wallet address/);
    expect(() => assertSolanaInstructionsSafe(tx, { walletAddress: null })).toThrow(/without the signing wallet address/);
    expect(() => assertSolanaInstructionsSafe(tx)).toThrow(/without the signing wallet address/);
  });

  it('rejects an Approve instruction authorized by the wallet', () => {
    const wallet = generateSolanaWallet().address;
    const sourceAccount = generateSolanaWallet().address;
    const delegate = generateSolanaWallet().address;
    const tx = buildTransaction({
      accountKeys: [wallet, sourceAccount, delegate, TOKEN_PROGRAM],
      // Approve: [source, delegate, owner(authority, signer)]
      instructions: [{ programIdIndex: 3, accountIndexes: [1, 2, 0], data: Buffer.from([4]) }],
    });
    expect(() => assertSolanaInstructionsSafe(tx, { walletAddress: wallet }))
      .toThrow(/grants a token delegate/);
  });

  it('rejects an ApproveChecked instruction authorized by the wallet', () => {
    const wallet = generateSolanaWallet().address;
    const sourceAccount = generateSolanaWallet().address;
    const mint = generateSolanaWallet().address;
    const delegate = generateSolanaWallet().address;
    const tx = buildTransaction({
      accountKeys: [wallet, sourceAccount, mint, delegate, TOKEN_PROGRAM],
      // ApproveChecked: [source, mint, delegate, owner(authority, signer)]
      instructions: [{ programIdIndex: 4, accountIndexes: [1, 2, 3, 0], data: Buffer.from([13]) }],
    });
    expect(() => assertSolanaInstructionsSafe(tx, { walletAddress: wallet }))
      .toThrow(/grants a token delegate/);
  });

  it('does not reject an Approve instruction whose authority is not the wallet', () => {
    // Can't actually execute with our signature anyway — SPL Token requires
    // the authority to sign, and we're not providing that account's signature.
    const wallet = generateSolanaWallet().address;
    const sourceAccount = generateSolanaWallet().address;
    const delegate = generateSolanaWallet().address;
    const someoneElse = generateSolanaWallet().address;
    const tx = buildTransaction({
      accountKeys: [wallet, sourceAccount, delegate, someoneElse, TOKEN_PROGRAM],
      instructions: [{ programIdIndex: 4, accountIndexes: [1, 2, 3], data: Buffer.from([4]) }],
    });
    expect(() => assertSolanaInstructionsSafe(tx, { walletAddress: wallet })).not.toThrow();
  });

  it('rejects a SetAuthority instruction authorized by the wallet', () => {
    const wallet = generateSolanaWallet().address;
    const account = generateSolanaWallet().address;
    const tx = buildTransaction({
      accountKeys: [wallet, account, TOKEN_PROGRAM],
      // SetAuthority: [account, current authority(signer)]
      instructions: [{ programIdIndex: 2, accountIndexes: [1, 0], data: Buffer.from([6, 2]) }],
    });
    expect(() => assertSolanaInstructionsSafe(tx, { walletAddress: wallet }))
      .toThrow(/changes a token account's authority/);
  });

  it('allows a CloseAccount instruction that returns rent to the wallet itself', () => {
    const wallet = generateSolanaWallet().address;
    const account = generateSolanaWallet().address;
    const tx = buildTransaction({
      accountKeys: [wallet, account, TOKEN_PROGRAM],
      // CloseAccount: [account, destination, authority(signer)] — destination == wallet (index 0)
      instructions: [{ programIdIndex: 2, accountIndexes: [1, 0, 0], data: Buffer.from([9]) }],
    });
    expect(() => assertSolanaInstructionsSafe(tx, { walletAddress: wallet })).not.toThrow();
  });

  it('rejects a CloseAccount instruction that sends rent to a stranger', () => {
    const wallet = generateSolanaWallet().address;
    const account = generateSolanaWallet().address;
    const stranger = generateSolanaWallet().address;
    const tx = buildTransaction({
      accountKeys: [wallet, account, stranger, TOKEN_PROGRAM],
      instructions: [{ programIdIndex: 3, accountIndexes: [1, 2, 0], data: Buffer.from([9]) }],
    });
    expect(() => assertSolanaInstructionsSafe(tx, { walletAddress: wallet }))
      .toThrow(/closes a token account and sends the reclaimed rent/);
  });

  it('rejects an excessive compute-budget priority fee', () => {
    const wallet = generateSolanaWallet().address;
    const tx = buildTransaction({
      accountKeys: [wallet, COMPUTE_BUDGET_PROGRAM],
      instructions: [
        { programIdIndex: 1, accountIndexes: [], data: computeBudgetSetLimit(1_400_000) },
        { programIdIndex: 1, accountIndexes: [], data: computeBudgetSetPrice(10_000_000) }, // 0.014 SOL priority fee, over the 0.01 SOL cap
      ],
    });
    expect(() => assertSolanaInstructionsSafe(tx, { walletAddress: wallet }))
      .toThrow(/excessive priority fee/);
  });

  it('assumes the max compute-unit ceiling when a price is set with no explicit limit', () => {
    const wallet = generateSolanaWallet().address;
    // A price that's fine at a small limit but excessive at Solana's 1.4M-unit ceiling.
    const tx = buildTransaction({
      accountKeys: [wallet, COMPUTE_BUDGET_PROGRAM],
      instructions: [{ programIdIndex: 1, accountIndexes: [], data: computeBudgetSetPrice(10_000_000) }],
    });
    expect(() => assertSolanaInstructionsSafe(tx, { walletAddress: wallet }))
      .toThrow(/excessive priority fee/);
  });

  it('allows a modest, explicitly-bounded compute-budget priority fee', () => {
    const wallet = generateSolanaWallet().address;
    const tx = buildTransaction({
      accountKeys: [wallet, COMPUTE_BUDGET_PROGRAM],
      instructions: [
        { programIdIndex: 1, accountIndexes: [], data: computeBudgetSetLimit(200_000) },
        { programIdIndex: 1, accountIndexes: [], data: computeBudgetSetPrice(1000) },
      ],
    });
    expect(() => assertSolanaInstructionsSafe(tx, { walletAddress: wallet })).not.toThrow();
  });
});
