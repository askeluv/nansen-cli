/**
 * Tests for walletconnect-x402.js — policy guard wiring in handleX402Payment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../x402-policy.js', () => ({
  evaluatePaymentRequirement: vi.fn(),
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
