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
  resolvePaymentAmount,
  resolvePayTo,
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

  it('is case-SENSITIVE on Solana mint addresses (base58, not checksummed hex)', () => {
    // Regression: flipping case in a base58 string decodes to different bytes
    // entirely — unlike EVM hex, there is no case-insensitive equivalence.
    const caseFlipped = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1V'; // last char V not v
    const entry = resolveKnownToken('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', caseFlipped);
    expect(entry).toBeNull();
  });

  it('requires the exact "solana:" prefix, matching isSvmNetwork (no bare "solana" match)', () => {
    // Regression: resolveKnownToken previously used network.startsWith('solana')
    // (no colon), which disagreed with isSvmNetwork()'s exact 'solana:' check
    // in x402-svm.js and could let the guard approve a requirement neither
    // isEvmNetwork nor isSvmNetwork would ever dispatch to a signer.
    const entry = resolveKnownToken('solana-devnet', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(entry).toBeNull();
  });
});

describe('resolvePayTo', () => {
  it('prefers payTo over pay_to', () => {
    expect(resolvePayTo({ payTo: '0xCamel', pay_to: '0xSnake' })).toBe('0xCamel');
  });

  it('falls back to pay_to when payTo is undefined', () => {
    expect(resolvePayTo({ pay_to: '0xSnake' })).toBe('0xSnake');
  });

  it('falls back to pay_to when payTo is an empty string', () => {
    // Regression: an empty payTo must not be treated as a real recipient —
    // this is the same class of bug resolvePaymentAmount closes for amount.
    expect(resolvePayTo({ payTo: '', pay_to: '0xSnake' })).toBe('0xSnake');
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

  it('10a. missing amount and maxAmountRequired → refused with clear message', () => {
    const req = { ...BASE_USDC_REQUIREMENT };
    delete req.amount;
    delete req.maxAmountRequired;
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/amount field is missing/i);
  });

  it('11. negative amount → refused, no throw', () => {
    const req = { ...BASE_USDC_REQUIREMENT, amount: '-1000000' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/negative amount/i);
  });

  it('12. missing payTo and pay_to → refused with clear message', () => {
    const req = { ...BASE_USDC_REQUIREMENT };
    delete req.payTo;
    delete req.pay_to;
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/payTo field is missing/i);
  });

  it('uses pay_to field when payTo is absent', () => {
    const req = { ...BASE_USDC_REQUIREMENT };
    delete req.payTo;
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(true);
  });

  it('falls back to pay_to when payTo is an empty string (not refused by an unset allowlist)', () => {
    // Regression: empty payTo must resolve to pay_to everywhere the guard and
    // the signers look at it, exactly like the amount empty-string fallback.
    const req = { ...BASE_USDC_REQUIREMENT, payTo: '' };
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

  it('empty-string amount falls back to maxAmountRequired instead of evaluating as $0 (cap-bypass regression)', () => {
    // A malicious server sending amount: "" alongside a huge maxAmountRequired
    // must not slip through the cap at $0.00 while a signer later substitutes
    // maxAmountRequired for the falsy amount and signs the large value instead.
    const req = { ...BASE_USDC_REQUIREMENT, amount: '', maxAmountRequired: '1000000000000' };
    const result = evaluatePaymentRequirement(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds the/i);
  });
});

describe('resolvePaymentAmount', () => {
  it('prefers amount over maxAmountRequired', () => {
    expect(resolvePaymentAmount({ amount: '10000', maxAmountRequired: '999' })).toBe('10000');
  });

  it('falls back to maxAmountRequired when amount is undefined', () => {
    expect(resolvePaymentAmount({ maxAmountRequired: '10000' })).toBe('10000');
  });

  it('falls back to maxAmountRequired when amount is an empty string', () => {
    expect(resolvePaymentAmount({ amount: '', maxAmountRequired: '10000' })).toBe('10000');
  });

  it('keeps a literal 0 amount instead of falling back', () => {
    expect(resolvePaymentAmount({ amount: 0, maxAmountRequired: '10000' })).toBe(0);
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

  it('payTo takes precedence over pay_to — allowlist bypass attack is blocked', () => {
    // A server that sends { pay_to: "0xAllowed", payTo: "0xAttacker" } must be
    // refused: the policy must evaluate the same field the signing paths use.
    // Signing paths (WalletConnect, Privy, EVM, SVM) all prefer payTo (camelCase)
    // so the policy must also read payTo first.
    process.env.NANSEN_X402_ALLOWED_PAYTO = '0xAllowed';
    const req = {
      ...BASE_USDC_REQUIREMENT,
      payTo: '0xAttacker',
      pay_to: '0xAllowed',
    };
    const result = evaluatePaymentRequirement(req);
    // Policy sees payTo = "0xAttacker" which is NOT in the allowlist → refused
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/NANSEN_X402_ALLOWED_PAYTO/);
  });

  it('pay_to used as fallback when payTo is absent', () => {
    // Only pay_to present (v1 field name): should still be evaluated correctly.
    process.env.NANSEN_X402_ALLOWED_PAYTO = '0xPaymentRecipient';
    const req = { ...BASE_USDC_REQUIREMENT };
    delete req.payTo;
    req.pay_to = '0xPaymentRecipient';
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

  it('treats an empty-string env var as unset rather than a $0.00 cap', () => {
    // Number('') === 0, which would otherwise refuse every non-zero payment.
    process.env.NANSEN_X402_MAX_AMOUNT = '';
    expect(resolveMaxAmountUsd()).toBe(DEFAULT_X402_MAX_AMOUNT_USD);
  });

  it('treats a whitespace-only env var as unset', () => {
    process.env.NANSEN_X402_MAX_AMOUNT = '   ';
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

  it('is case-insensitive for an EVM network', () => {
    process.env.NANSEN_X402_ALLOWED_PAYTO = '0xAbCdEf';
    expect(isPayToAllowed('0xabcdef', 'eip155:8453')).toBe(true);
  });

  it('is case-SENSITIVE for a Solana network (base58 allowlist)', () => {
    // Regression: lowercasing both sides let a case-flipped Solana address
    // pass an allowlist meant to restrict to one exact address.
    const real = 'J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYx';
    const caseFlipped = 'J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYX'; // last char X not x
    process.env.NANSEN_X402_ALLOWED_PAYTO = real;
    expect(isPayToAllowed(real, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(true);
    expect(isPayToAllowed(caseFlipped, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(false);
  });
});
