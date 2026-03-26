import { describe, it, expect } from 'vitest';
import { validateQuoteInput } from '../trade-validation.js';

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
});

describe('quote handler integration', () => {
  it('rejects same-token swap at quote time', async () => {
    const { buildTradingCommands } = await import('../trading.js');
    const logs = [];
    let exitCode = null;
    const commands = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: (code) => { exitCode = code; },
    });

    await commands.quote([], null, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'SOL',
      amount: '1000000000',
    });

    expect(exitCode).toBe(1);
    expect(logs.some(l => /Cannot swap .* for itself/.test(l))).toBe(true);
  });

  it('rejects invalid address format at quote time', async () => {
    const { buildTradingCommands } = await import('../trading.js');
    const logs = [];
    let exitCode = null;
    const commands = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: (code) => { exitCode = code; },
    });

    await commands.quote([], null, {}, {
      chain: 'solana',
      from: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      to: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: '1000000000',
    });

    expect(exitCode).toBe(1);
    expect(logs.some(l => /Invalid sell token address/.test(l))).toBe(true);
  });
});
