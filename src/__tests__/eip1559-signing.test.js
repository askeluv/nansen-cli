import { describe, it, expect } from 'vitest';
import { RLP } from '@ethereumjs/rlp';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak256 } from '../crypto.js';
import { signEvmTransaction, signEip1559Transaction } from '../trading.js';

// Valid secp256k1 scalar, matching the convention in perp.test.js. Deliberately
// not a random 64-hex literal: those read as a real private key to secret
// scanners, and nothing here depends on the key's value — the recovery test
// derives the expected address from it.
const KEY = '11'.repeat(32);
const BASE_CHAIN_ID = 8453;

function addressForKey(privHex) {
  const pub = secp256k1.getPublicKey(Buffer.from(privHex, 'hex'), false);
  return '0x' + Buffer.from(keccak256(Buffer.from(pub).subarray(1))).subarray(12).toString('hex');
}

function bufToBigInt(u8) {
  const hex = Buffer.from(u8).toString('hex');
  return hex === '' ? 0n : BigInt('0x' + hex);
}

// Decode 0x02 || RLP([...]) back into its 12 fields.
function decodeType2(raw) {
  const bytes = Buffer.from(raw.slice(2), 'hex');
  expect(bytes[0]).toBe(0x02);
  const fields = RLP.decode(Uint8Array.from(bytes.subarray(1)));
  return { fields, payload: bytes.subarray(1) };
}

const TX = {
  nonce: 18,
  // Numbers, not hand-written hex: the fee values are deliberately different so
  // a maxFee/priority transposition fails the ordering assertions below.
  maxPriorityFeePerGas: 1100000,
  maxFeePerGas: 6600000,
  gasLimit: 73112,
  to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  value: '0x0',
  data: '0x095ea7b3',
  chainId: BASE_CHAIN_ID,
};

describe('signEip1559Transaction envelope', () => {
  const raw = signEip1559Transaction(TX, KEY);

  it('is a type-2 envelope with 12 RLP fields', () => {
    const { fields } = decodeType2(raw);
    expect(fields).toHaveLength(12);
  });

  // Pins the EIP-1559 field order independently of the signer: the fee values
  // differ, so swapping maxFee and priority would fail here.
  it('orders fields per EIP-1559', () => {
    const { fields } = decodeType2(raw);
    expect(bufToBigInt(fields[0])).toBe(BigInt(BASE_CHAIN_ID));
    expect(bufToBigInt(fields[1])).toBe(18n);
    expect(bufToBigInt(fields[2])).toBe(1100000n);            // maxPriorityFeePerGas
    expect(bufToBigInt(fields[3])).toBe(6600000n);            // maxFeePerGas
    expect(bufToBigInt(fields[4])).toBe(73112n);              // gasLimit
    expect('0x' + Buffer.from(fields[5]).toString('hex')).toBe(TX.to);
    expect(bufToBigInt(fields[6])).toBe(0n);                  // value
    expect('0x' + Buffer.from(fields[7]).toString('hex')).toBe(TX.data);
    expect(fields[8]).toEqual([]);                            // accessList
  });

  it('uses a raw yParity of 0 or 1, not an EIP-155 v', () => {
    const { fields } = decodeType2(raw);
    const yParity = bufToBigInt(fields[9]);
    expect([0n, 1n]).toContain(yParity);
    // EIP-155 would put chainId*2+35+bit here, which for Base is >= 16941.
    expect(yParity).toBeLessThan(2n);
  });

  // The real check: recover the signer from the signature over the unsigned
  // payload and confirm it is the key's own address. A wrong hash, wrong
  // yParity or mis-serialised r/s all fail here.
  it('recovers to the signing address', () => {
    const { fields } = decodeType2(raw);
    const unsignedPayload = Buffer.concat([
      Buffer.from([0x02]),
      Buffer.from(RLP.encode(fields.slice(0, 9))),
    ]);
    const msgHash = keccak256(unsignedPayload);

    const r = Buffer.from(fields[10]).toString('hex').padStart(64, '0');
    const s = Buffer.from(fields[11]).toString('hex').padStart(64, '0');
    const yParity = Number(bufToBigInt(fields[9]));

    const sig = secp256k1.Signature
      .fromBytes(Buffer.from(r + s, 'hex'), 'compact')
      .addRecoveryBit(yParity);
    const pub = sig.recoverPublicKey(msgHash).toBytes(false);
    const recovered = '0x' + Buffer.from(keccak256(Buffer.from(pub).subarray(1))).subarray(12).toString('hex');

    expect(recovered).toBe(addressForKey(KEY));
  });
});

describe('signEvmTransaction transaction-type selection', () => {
  const base = {
    to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    data: '0x095ea7b3',
    value: '0',
    gas: '73112',
  };

  it('emits type 2 when the quote carries fee caps', () => {
    const raw = signEvmTransaction(
      { ...base, maxFeePerGas: '6600000', maxPriorityFeePerGas: '1100000' },
      KEY, 'base', 18,
    );
    expect(raw.startsWith('0x02')).toBe(true);
  });

  it('preserves both fee fields rather than flattening them', () => {
    const raw = signEvmTransaction(
      { ...base, maxFeePerGas: '6600000', maxPriorityFeePerGas: '1100000' },
      KEY, 'base', 18,
    );
    const { fields } = decodeType2(raw);
    expect(bufToBigInt(fields[2])).toBe(1100000n);
    expect(bufToBigInt(fields[3])).toBe(6600000n);
  });

  it('falls back to the fee cap when only maxFeePerGas is given', () => {
    const raw = signEvmTransaction({ ...base, maxFeePerGas: '6600000' }, KEY, 'base', 18);
    const { fields } = decodeType2(raw);
    expect(bufToBigInt(fields[2])).toBe(6600000n);
    expect(bufToBigInt(fields[3])).toBe(6600000n);
  });

  it('still emits legacy for a gasPrice-only quote', () => {
    const raw = signEvmTransaction({ ...base, gasPrice: '6600000' }, KEY, 'base', 18);
    expect(raw.startsWith('0x02')).toBe(false);
  });

  // The old fallback signed a 1-wei transaction: unmineable, and it burns the
  // nonce for every later attempt.
  it('refuses to sign when the quote has no fee information', () => {
    expect(() => signEvmTransaction({ ...base }, KEY, 'base', 18)).toThrow(
      /no gas price.*Refusing to sign/s,
    );
  });
});
