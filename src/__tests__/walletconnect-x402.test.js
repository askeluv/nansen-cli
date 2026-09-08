/**
 * Tests for walletconnect-x402.js — policy guard wiring in handleX402Payment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../x402-policy.js', () => ({
  evaluatePaymentRequirement: vi.fn(),
  resolvePaymentAmount: (requirement) =>
    requirement.amount !== undefined && requirement.amount !== null && requirement.amount !== ''
      ? requirement.amount
      : requirement.maxAmountRequired,
  resolvePayTo: (requirement) =>
    requirement.payTo !== undefined && requirement.payTo !== null && requirement.payTo !== ''
      ? requirement.payTo
      : requirement.pay_to,
}));

vi.mock('../walletconnect-exec.js', () => ({
  wcExec: vi.fn(),
}));

import { evaluatePaymentRequirement } from '../x402-policy.js';
import { wcExec } from '../walletconnect-exec.js';
import { handleX402Payment, buildEIP712TypedData } from '../walletconnect-x402.js';

const CONNECTED_WALLET = {
  connected: true,
  accounts: [{ address: '0xWalletAddress' }],
};

const REQUIREMENT = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0xRecipient',
  amount: '10000',
  maxTimeoutSeconds: 120,
  extra: { name: 'USD Coin', version: '2', chainId: 8453 },
};

const PAYMENT_REQUIREMENTS = { accepts: [REQUIREMENT] };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: wallet connected, wcExec returns whoami then sign result
  wcExec.mockImplementation((_cmd, args) => {
    if (args[0] === 'whoami') {
      return Promise.resolve(JSON.stringify(CONNECTED_WALLET));
    }
    return Promise.resolve(JSON.stringify({ signature: '0xfakesig' }));
  });
});

describe('handleX402Payment — policy guard', () => {
  it('throws with the refusal reason when evaluatePaymentRequirement returns ok: false', async () => {
    evaluatePaymentRequirement.mockReturnValue({
      ok: false,
      reason: 'Refusing to auto-pay: test refusal',
    });

    await expect(
      handleX402Payment(PAYMENT_REQUIREMENTS),
    ).rejects.toThrow('Refusing to auto-pay: test refusal');

    // Signing (wcExec sign-typed-data) must never be reached
    const signCalls = wcExec.mock.calls.filter(c => c[1]?.[0] === 'sign-typed-data');
    expect(signCalls).toHaveLength(0);
  });

  it('proceeds to sign when evaluatePaymentRequirement returns ok: true', async () => {
    evaluatePaymentRequirement.mockReturnValue({ ok: true, usd: 0.01, symbol: 'USDC' });

    const result = await handleX402Payment(PAYMENT_REQUIREMENTS);

    expect(typeof result).toBe('string');
    const decoded = JSON.parse(Buffer.from(result, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.payload.signature).toBe('0xfakesig');

    const signCalls = wcExec.mock.calls.filter(c => c[1]?.[0] === 'sign-typed-data');
    expect(signCalls).toHaveLength(1);
  });
});

describe('buildEIP712TypedData — payTo field normalisation', () => {
  it('uses payTo (camelCase) when both payTo and pay_to are present', () => {
    const req = { ...REQUIREMENT, payTo: '0xCamel', pay_to: '0xSnake' };
    const td = buildEIP712TypedData({ fromAddress: '0xSender', requirement: req });
    expect(td.message.to).toBe('0xCamel');
  });

  it('falls back to pay_to when payTo is absent', () => {
    const req = { ...REQUIREMENT };
    delete req.payTo;
    req.pay_to = '0xSnakeOnly';
    const td = buildEIP712TypedData({ fromAddress: '0xSender', requirement: req });
    expect(td.message.to).toBe('0xSnakeOnly');
  });
});

describe('buildEIP712TypedData — chain id binding', () => {
  it('derives chain id from the CAIP-2 network field, ignoring extra.chainId when consistent', () => {
    // extra.chainId agrees with network → allowed, domain.chainId = 8453
    const req = { ...REQUIREMENT, network: 'eip155:8453', extra: { ...REQUIREMENT.extra, chainId: 8453 } };
    const td = buildEIP712TypedData({ fromAddress: '0xSender', requirement: req });
    expect(td.domain.chainId).toBe(8453);
  });

  it('derives chain id from network when extra.chainId is absent', () => {
    const req = { ...REQUIREMENT, extra: { name: 'USD Coin', version: '2' } };
    const td = buildEIP712TypedData({ fromAddress: '0xSender', requirement: req });
    expect(td.domain.chainId).toBe(8453);
  });

  it('treats a null or empty-string extra.chainId as absent, not a conflict', () => {
    // null/'' mean "unspecified" (Number(null)===0, Number('')===0) and must not
    // be read as a chain id of 0 conflicting with the network.
    for (const chainId of [null, '']) {
      const req = { ...REQUIREMENT, network: 'eip155:8453', extra: { ...REQUIREMENT.extra, chainId } };
      const td = buildEIP712TypedData({ fromAddress: '0xSender', requirement: req });
      expect(td.domain.chainId).toBe(8453);
    }
  });

  it('throws when extra.chainId conflicts with the validated network', () => {
    // remote extra.chainId: 1 on a Base requirement must be rejected — not signed
    const req = { ...REQUIREMENT, network: 'eip155:8453', extra: { ...REQUIREMENT.extra, chainId: 1 } };
    expect(() => buildEIP712TypedData({ fromAddress: '0xSender', requirement: req })).toThrow(
      /extra\.chainId.*conflicts with.*network/i,
    );
  });

  it('throws when network is missing or not an EVM CAIP-2 id', () => {
    const req = { ...REQUIREMENT, network: 'bogus' };
    expect(() => buildEIP712TypedData({ fromAddress: '0xSender', requirement: req })).toThrow(
      /unsupported or missing EVM network/i,
    );
  });

  it('throws when extra is missing entirely', () => {
    const req = { ...REQUIREMENT };
    delete req.extra;
    expect(() => buildEIP712TypedData({ fromAddress: '0xSender', requirement: req })).toThrow(
      /EIP-712 domain name\/version missing/i,
    );
  });

  it('throws when extra.name is absent', () => {
    const req = { ...REQUIREMENT, extra: { version: '2' } };
    expect(() => buildEIP712TypedData({ fromAddress: '0xSender', requirement: req })).toThrow(
      /EIP-712 domain name\/version missing/i,
    );
  });

  it('throws when extra.version is absent', () => {
    const req = { ...REQUIREMENT, extra: { name: 'USD Coin' } };
    expect(() => buildEIP712TypedData({ fromAddress: '0xSender', requirement: req })).toThrow(
      /EIP-712 domain name\/version missing/i,
    );
  });
});
