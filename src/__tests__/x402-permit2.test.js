/**
 * Tests for Permit2 (permit2-exact) x402 payment signing.
 *
 * The digest test vector was computed with an independent EIP-712
 * implementation (Python eth_account) over the same typed data, so it
 * cross-validates the nested-struct hashing end to end.
 */

import { describe, it, expect } from 'vitest';
import {
  createEvmPaymentPayload,
  createPermit2ExactPayload,
  hashPermit2WitnessTransfer,
  PERMIT2_ADDRESS,
} from '../x402-evm.js';
import { generateEvmWallet } from '../wallet.js';

const REQUIREMENTS_PERMIT2 = {
  scheme: 'exact',
  network: 'eip155:56',
  asset: '0x1000000000000000000000000000000000000001',
  amount: '10000000000000000',
  payTo: '0x3000000000000000000000000000000000000003',
  maxTimeoutSeconds: 300,
  extra: {
    name: 'Test Token',
    version: '1',
    assetTransferMethod: 'permit2-exact',
    signerAddress: '0x4000000000000000000000000000000000000004',
    spenderAddress: '0x2000000000000000000000000000000000000002',
  },
};

describe('hashPermit2WitnessTransfer', () => {
  it('matches an independently computed EIP-712 digest', () => {
    // Reference digest computed with Python eth_account over identical input.
    const digest = hashPermit2WitnessTransfer(56, {
      permitted: {
        token: '0x1000000000000000000000000000000000000001',
        amount: 10000000000000000n,
      },
      spender: '0x2000000000000000000000000000000000000002',
      nonce: 123456789n,
      deadline: 1750000000n,
      witness: {
        to: '0x3000000000000000000000000000000000000003',
        validAfter: 1749999000n,
      },
    });
    expect('0x' + digest.toString('hex')).toBe(
      '0x84f21d844cc4f15e21f03e16da32687d28e4a1ce8bca3de73a5b8625f02c390b',
    );
  });

  it('uses the canonical Permit2 contract address', () => {
    expect(PERMIT2_ADDRESS).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3');
  });
});

describe('createPermit2ExactPayload', () => {
  it('builds a permit2Authorization payload with decimal-string fields', () => {
    const wallet = generateEvmWallet();
    const b64 = createPermit2ExactPayload(
      REQUIREMENTS_PERMIT2, wallet.privateKey, wallet.address, 'https://api.example.com/x',
    );
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString());

    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual(REQUIREMENTS_PERMIT2);
    expect(payload.resource).toEqual({ url: 'https://api.example.com/x' });

    const auth = payload.payload.permit2Authorization;
    expect(auth.from).toBe(wallet.address);
    expect(auth.spender).toBe('0x2000000000000000000000000000000000000002');
    expect(auth.permitted).toEqual({
      token: REQUIREMENTS_PERMIT2.asset,
      amount: REQUIREMENTS_PERMIT2.amount,
    });
    expect(auth.witness.to).toBe(REQUIREMENTS_PERMIT2.payTo);
    // Wire-format numerics are decimal strings.
    expect(auth.nonce).toMatch(/^\d+$/);
    expect(auth.deadline).toMatch(/^\d+$/);
    expect(auth.witness.validAfter).toMatch(/^\d+$/);
    // EIP-3009 fields must be absent.
    expect(payload.payload.authorization).toBeUndefined();
    expect(payload.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('throws when spenderAddress is missing', () => {
    const wallet = generateEvmWallet();
    const req = {
      ...REQUIREMENTS_PERMIT2,
      extra: { ...REQUIREMENTS_PERMIT2.extra, spenderAddress: undefined },
    };
    expect(() =>
      createPermit2ExactPayload(req, wallet.privateKey, wallet.address, 'u'),
    ).toThrow(/spenderAddress/);
  });
});

describe('createEvmPaymentPayload method routing', () => {
  it('routes permit2-exact to the Permit2 payload', () => {
    const wallet = generateEvmWallet();
    const b64 = createEvmPaymentPayload(
      REQUIREMENTS_PERMIT2, wallet.privateKey, wallet.address, 'u',
    );
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString());
    expect(payload.payload.permit2Authorization).toBeDefined();
  });

  it('keeps the EIP-3009 path when assetTransferMethod is eip3009 or absent', () => {
    const wallet = generateEvmWallet();
    for (const extra of [
      { name: 'Test Token', version: '1' },
      { name: 'Test Token', version: '1', assetTransferMethod: 'eip3009' },
    ]) {
      const b64 = createEvmPaymentPayload(
        { ...REQUIREMENTS_PERMIT2, extra }, wallet.privateKey, wallet.address, 'u',
      );
      const payload = JSON.parse(Buffer.from(b64, 'base64').toString());
      expect(payload.payload.authorization).toBeDefined();
      expect(payload.payload.permit2Authorization).toBeUndefined();
    }
  });

  it('throws on unsupported transfer methods so fallback can continue', () => {
    const wallet = generateEvmWallet();
    const req = {
      ...REQUIREMENTS_PERMIT2,
      extra: { ...REQUIREMENTS_PERMIT2.extra, assetTransferMethod: 'permit2-upto' },
    };
    expect(() =>
      createEvmPaymentPayload(req, wallet.privateKey, wallet.address, 'u'),
    ).toThrow(/assetTransferMethod/);
  });
});
