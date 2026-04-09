import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { validateQuoteInput, fetchNativeBalance, fetchTokenBalance, validateBalance, resolvePercentAmount, validateGasBalance } from '../trade-validation.js';

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
