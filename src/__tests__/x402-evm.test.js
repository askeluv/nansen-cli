/**
 * Tests for x402 EVM payment module
 */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { hashTypedData, createEvmPaymentPayload, createPermit2ExactPayload, isEvmNetwork } from '../x402-evm.js';
import { generateEvmWallet } from '../wallet.js';

describe('EIP-712 hashTypedData', () => {
  it('should produce a 32-byte hash', () => {
    const domain = {
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    };

    const fields = [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ];

    const message = {
      from: '0x1234567890abcdef1234567890abcdef12345678',
      to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      value: 50000n,
      validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: '0x' + crypto.randomBytes(32).toString('hex'),
    };

    const hash = hashTypedData(domain, 'TransferWithAuthorization', fields, message);
    expect(hash).toBeInstanceOf(Buffer);
    expect(hash.length).toBe(32);
  });

  it('should produce different hashes for different messages', () => {
    const domain = {
      name: 'Test Token',
      version: '1',
      chainId: 1,
      verifyingContract: '0x0000000000000000000000000000000000000001',
    };

    const fields = [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ];

    const msg1 = {
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: 100n,
      validAfter: 0n,
      validBefore: 9999999999n,
      nonce: '0x' + '00'.repeat(32),
    };

    const msg2 = { ...msg1, value: 200n };

    const hash1 = hashTypedData(domain, 'TransferWithAuthorization', fields, msg1);
    const hash2 = hashTypedData(domain, 'TransferWithAuthorization', fields, msg2);
    expect(hash1.toString('hex')).not.toBe(hash2.toString('hex'));
  });
});

describe('createEvmPaymentPayload', () => {
  it('should create a valid base64-encoded payload', () => {
    const wallet = generateEvmWallet();
    const requirements = {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '50000',
      pay_to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      extra: { name: 'USD Coin', version: '2' },
    };

    const result = createEvmPaymentPayload(
      requirements,
      wallet.privateKey,
      wallet.address,
      'https://api.nansen.ai/v1/test',
    );

    // Should be valid base64
    const decoded = JSON.parse(Buffer.from(result, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted.scheme).toBe('exact');
    expect(decoded.accepted.network).toBe('eip155:8453');
    expect(decoded.payload.authorization).toBeDefined();
    expect(decoded.payload.authorization.from).toBe(wallet.address);
    expect(decoded.payload.signature).toMatch(/^0x/);
    expect(decoded.resource.url).toBe('https://api.nansen.ai/v1/test');
  });

  it('signs maxAmountRequired when amount is an empty string (matches resolvePaymentAmount, not a raw fallback)', () => {
    // Regression: this signer must resolve the amount the same way the policy
    // guard does, so a signed value never diverges from the guarded value.
    const wallet = generateEvmWallet();
    const requirements = {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '',
      maxAmountRequired: '50000',
      pay_to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      extra: { name: 'USD Coin', version: '2' },
    };

    const result = createEvmPaymentPayload(
      requirements,
      wallet.privateKey,
      wallet.address,
      'https://api.nansen.ai/v1/test',
    );

    const decoded = JSON.parse(Buffer.from(result, 'base64').toString('utf8'));
    expect(decoded.payload.authorization.value).toBe('50000');
  });

  it('should throw if extra.name is missing', () => {
    const wallet = generateEvmWallet();
    const requirements = {
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '50000',
      pay_to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      extra: {},
    };

    expect(() => createEvmPaymentPayload(
      requirements, wallet.privateKey, wallet.address, 'https://test.com',
    )).toThrow('name missing');
  });
});

describe('createPermit2ExactPayload', () => {
  it('signs maxAmountRequired when amount is an empty string (matches resolvePaymentAmount)', () => {
    const wallet = generateEvmWallet();
    const requirements = {
      scheme: 'exact',
      network: 'eip155:56',
      asset: '0x55d398326f99059fF775485246999027B3197955',
      amount: '',
      maxAmountRequired: '10000000000000000',
      pay_to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      extra: { spenderAddress: '0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633' },
    };

    const result = createPermit2ExactPayload(
      requirements,
      wallet.privateKey,
      wallet.address,
      'https://api.nansen.ai/v1/test',
    );

    const decoded = JSON.parse(Buffer.from(result, 'base64').toString('utf8'));
    expect(decoded.payload.permit2Authorization.permitted.amount).toBe('10000000000000000');
  });
});

describe('isEvmNetwork', () => {
  it('should return true for EVM networks', () => {
    expect(isEvmNetwork('eip155:8453')).toBe(true);
    expect(isEvmNetwork('eip155:1')).toBe(true);
  });

  it('should return false for non-EVM networks', () => {
    expect(isEvmNetwork('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(false);
    expect(isEvmNetwork('')).toBe(false);
    expect(isEvmNetwork(null)).toBe(false);
  });
});
