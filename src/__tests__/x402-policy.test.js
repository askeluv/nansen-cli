/**
 * Tests for src/x402-policy.js
 * Covers the known-asset allowlist, per-payment USD cap, and payTo allowlist.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock wallet.js so getWalletConfig doesn't touch the filesystem.
vi.mock('../wallet.js', () => ({
  getWalletConfig: () => ({}),
}));

// Import after mock is registered.
const {
  resolveKnownToken,
  evaluatePaymentRequirement,
  resolveMaxAmountUsd,
  isPayToAllowed,
  DEFAULT_X402_MAX_AMOUNT_USD,
} = await import('../x402-policy.js');

// Canonical Base USDC requirement for reuse across tests.
const BASE_USDC_REQUIREMENT = {
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '10000', // 0.01 USDC (6 decimals)
  pay_to: '0xPaymentRecipient',
};

describe('resolveKnownToken', () => {
  it('returns token metadata for Base USDC', () => {
    const entry = resolveKnownToken('eip155:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(entry).toMatchObject({ symbol: 'USDC', decimals: 6 });
  });

  it('is case-insensitive on the asset address', () => {
    const entry = resolveKnownToken('eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(entry).not.toBeNull();
  });

  it('returns null for an unknown asset on a known network', () => {
    const entry = resolveKnownToken('eip155:8453', '0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001');
    expect(entry).toBeNull();
  });

  it('returns null for an unknown network', () => {
    const entry = resolveKnownToken('eip155:1', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(entry).toBeNull();
  });

  it('returns Solana USDC for the solana network', () => {
    const entry = resolveKnownToken('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(entry).toMatchObject({ symbol: 'USDC', decimals: 6 });
  });

  it('returns null when network or asset is not a string', () => {
    expect(resolveKnownToken(null, '0x123')).toBeNull();
    expect(resolveKnownToken('eip155:8453', null)).toBeNull();
  });
});

describe('evaluatePaymentRequirement — allowlist and basic pass', () => {
  it('1. known Base USDC small amount → ok, correct usd', () => {
    const result = evaluatePaymentRequirement(BASE_USDC_REQUIREMENT);
    expect(result.ok).toBe(true);
    expect(result.usd).toBeCloseTo(0.01, 5);
    expect(result.symbol).toBe('USDC');
  });

  it('4. unknown asset on known network → refused (allowlist)', () => {
    const req = { ...BASE_USDC_REQUIREMENT, asset: '0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a recognized/i);
  });

  it('5. unknown network → refused', () => {
    const req = { ...BASE_USDC_REQUIREMENT, network: 'eip155:1' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a recognized/i);
  });

  it('10. malformed amount → refused, no throw', () => {
    const req = { ...BASE_USDC_REQUIREMENT, amount: 'not-a-number' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unparseable amount/i);
  });

  it('11. negative amount → refused, no throw', () => {
    const req = { ...BASE_USDC_REQUIREMENT, amount: '-1000000' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/negative amount/i);
  });

  it('uses pay_to field when payTo is absent', () => {
    const req = { ...BASE_USDC_REQUIREMENT };
    delete req.payTo;
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
  });

  it('falls back to maxAmountRequired when amount is absent (v1 field name)', () => {
    // Older x402 implementations send maxAmountRequired instead of amount.
    // The guard must normalise both so it does not block payments the signing
    // paths would handle correctly.
    const req = { ...BASE_USDC_REQUIREMENT };
    delete req.amount;
    req.maxAmountRequired = '10000'; // 0.01 USDC — within cap
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
    expect(result.usd).toBeCloseTo(0.01, 5);
  });

  it('maxAmountRequired=0 is honoured (not replaced by undefined)', () => {
    // ?? not || ensures a literal 0 amount is not treated as falsy.
    const req = { ...BASE_USDC_REQUIREMENT };
    delete req.amount;
    req.maxAmountRequired = '0';
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
    expect(result.usd).toBe(0);
  });
});

describe('evaluatePaymentRequirement — USD cap', () => {
  afterEach(() => {
    delete process.env.NANSEN_X402_MAX_AMOUNT;
  });

  it('2. very large amount on known asset → refused (cap)', () => {
    // $1,000,000 in USDC base units = 1_000_000_000_000 (6 decimals)
    const req = { ...BASE_USDC_REQUIREMENT, amount: '1000000000000' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds the/i);
  });

  it('3a. amount just over $1.00 default cap → refused', () => {
    // $1.01 = 1_010_000 base units (USDC 6 decimals)
    const req = { ...BASE_USDC_REQUIREMENT, amount: '1010000' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
  });

  it('3b. amount just under $1.00 default cap → allowed', () => {
    // $0.99 = 990_000 base units
    const req = { ...BASE_USDC_REQUIREMENT, amount: '990000' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
  });

  it('3c. amount exactly at $1.00 default cap → allowed (inclusive boundary)', () => {
    // $1.00 = 1_000_000 base units; cap check is `usd > cap`, so exact cap passes
    const req = { ...BASE_USDC_REQUIREMENT, amount: '1000000' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
    expect(result.usd).toBe(1);
  });

  it('6. NANSEN_X402_MAX_AMOUNT=unlimited → $1M allowed', () => {
    process.env.NANSEN_X402_MAX_AMOUNT = 'unlimited';
    const req = { ...BASE_USDC_REQUIREMENT, amount: '1000000000000' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
  });

  it('7a. custom cap $5 → $3 payment allowed', () => {
    process.env.NANSEN_X402_MAX_AMOUNT = '5.00';
    const req = { ...BASE_USDC_REQUIREMENT, amount: '3000000' }; // $3.00
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
  });

  it('7b. custom cap $5 → $6 payment refused', () => {
    process.env.NANSEN_X402_MAX_AMOUNT = '5.00';
    const req = { ...BASE_USDC_REQUIREMENT, amount: '6000000' }; // $6.00
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds/i);
  });
});

describe('evaluatePaymentRequirement — payTo allowlist', () => {
  afterEach(() => {
    delete process.env.NANSEN_X402_ALLOWED_PAYTO;
    delete process.env.NANSEN_X402_MAX_AMOUNT;
  });

  it('8a. NANSEN_X402_ALLOWED_PAYTO matches pay_to → allowed', () => {
    process.env.NANSEN_X402_ALLOWED_PAYTO = '0xPaymentRecipient,0xOtherAddr';
    const result = evaluatePaymentRequirement(BASE_USDC_REQUIREMENT);
    expect(result.ok).toBe(true);
  });

  it('8b. NANSEN_X402_ALLOWED_PAYTO does not match → refused', () => {
    process.env.NANSEN_X402_ALLOWED_PAYTO = '0xSomeOtherAddress';
    const result = evaluatePaymentRequirement(BASE_USDC_REQUIREMENT);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/NANSEN_X402_ALLOWED_PAYTO/);
  });

  it('8c. NANSEN_X402_ALLOWED_PAYTO unset → any recipient allowed (subject to cap)', () => {
    const req = { ...BASE_USDC_REQUIREMENT, pay_to: '0xArbitraryAddress' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
  });
});

describe('evaluatePaymentRequirement — 18-decimal BSC token conversion', () => {
  afterEach(() => {
    delete process.env.NANSEN_X402_MAX_AMOUNT;
  });

  it('9. BSC USDT (18 decimals), small USD amount → correct conversion, allowed', () => {
    // 0.01 USDT on BSC = 10_000_000_000_000_000 base units (18 decimals)
    process.env.NANSEN_X402_MAX_AMOUNT = '1.00';
    const req = {
      network: 'eip155:56',
      asset: '0x55d398326f99059fF775485246999027B3197955', // USDT on BSC
      amount: '10000000000000000', // 0.01 USDT
      pay_to: '0xAny',
    };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
    expect(result.usd).toBeCloseTo(0.01, 5);
    expect(result.symbol).toBe('USDT');
  });
});

describe('resolveMaxAmountUsd', () => {
  afterEach(() => {
    delete process.env.NANSEN_X402_MAX_AMOUNT;
  });

  it('returns the default when env var is unset', () => {
    expect(resolveMaxAmountUsd()).toBe(DEFAULT_X402_MAX_AMOUNT_USD);
  });

  it('parses a numeric env var', () => {
    process.env.NANSEN_X402_MAX_AMOUNT = '5';
    expect(resolveMaxAmountUsd()).toBe(5);
  });

  it('returns Infinity for "unlimited"', () => {
    process.env.NANSEN_X402_MAX_AMOUNT = 'unlimited';
    expect(resolveMaxAmountUsd()).toBe(Infinity);
  });

  it('ignores garbage env var and falls through to default', () => {
    process.env.NANSEN_X402_MAX_AMOUNT = 'garbage';
    expect(resolveMaxAmountUsd()).toBe(DEFAULT_X402_MAX_AMOUNT_USD);
  });
});

describe('isPayToAllowed', () => {
  afterEach(() => {
    delete process.env.NANSEN_X402_ALLOWED_PAYTO;
  });

  it('returns true when env var is unset', () => {
    expect(isPayToAllowed('0xAnything')).toBe(true);
  });

  it('returns true for an address in the allowlist (case-insensitive)', () => {
    process.env.NANSEN_X402_ALLOWED_PAYTO = '0xABC,0xDEF';
    expect(isPayToAllowed('0xabc')).toBe(true);
  });

  it('returns false for an address not in the allowlist', () => {
    process.env.NANSEN_X402_ALLOWED_PAYTO = '0xABC';
    expect(isPayToAllowed('0xXYZ')).toBe(false);
  });
});
