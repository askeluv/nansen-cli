import { describe, it, expect } from 'vitest';
import { parseTransactionMessage, resolveStaticAccount } from '../solana-tx.js';
import { base58Decode, base58Encode, generateSolanaWallet } from '../wallet.js';

function encodeCompactU16(value) {
  if (value < 0x80) return Buffer.from([value]);
  if (value < 0x4000) return Buffer.from([(value & 0x7f) | 0x80, (value >> 7) & 0x7f]);
  return Buffer.from([(value & 0x7f) | 0x80, ((value >> 7) & 0x7f) | 0x80, (value >> 14) & 0x03]);
}

// Minimal, hand-rolled builder for test fixtures — deliberately independent
// of solana-tx.js so the parser is verified against an independent encoding,
// not against itself.
function buildMessageBytes({ versioned, versionByte = 0x80, accountKeys, header, recentBlockhash, instructions, addressTableLookups = [] }) {
  const parts = [];
  if (versioned) parts.push(Buffer.from([versionByte]));
  parts.push(Buffer.from([header.numRequiredSignatures, header.numReadonlySignedAccounts, header.numReadonlyUnsignedAccounts]));
  parts.push(encodeCompactU16(accountKeys.length));
  for (const k of accountKeys) parts.push(base58Decode(k));
  parts.push(base58Decode(recentBlockhash));
  parts.push(encodeCompactU16(instructions.length));
  for (const ix of instructions) {
    parts.push(Buffer.from([ix.programIdIndex]));
    parts.push(encodeCompactU16(ix.accountIndexes.length));
    for (const idx of ix.accountIndexes) parts.push(Buffer.from([idx]));
    parts.push(encodeCompactU16(ix.data.length));
    parts.push(ix.data);
  }
  if (versioned) {
    parts.push(encodeCompactU16(addressTableLookups.length));
    for (const alt of addressTableLookups) {
      parts.push(base58Decode(alt.lookupTableAddress));
      parts.push(encodeCompactU16(alt.writableIndexes.length));
      for (const idx of alt.writableIndexes) parts.push(Buffer.from([idx]));
      parts.push(encodeCompactU16(alt.readonlyIndexes.length));
      for (const idx of alt.readonlyIndexes) parts.push(Buffer.from([idx]));
    }
  }
  return Buffer.concat(parts);
}

function wrapTransaction(messageBytes, numSignatures = 1) {
  return Buffer.concat([encodeCompactU16(numSignatures), Buffer.alloc(numSignatures * 64), messageBytes]).toString('base64');
}

describe('parseTransactionMessage', () => {
  it('round-trips a legacy (non-versioned) message', () => {
    const signer = generateSolanaWallet().address;
    const programId = generateSolanaWallet().address;
    const recentBlockhash = generateSolanaWallet().address;
    const messageBytes = buildMessageBytes({
      versioned: false,
      accountKeys: [signer, programId],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      recentBlockhash,
      instructions: [{ programIdIndex: 1, accountIndexes: [0], data: Buffer.from([0xde, 0xad]) }],
    });
    const parsed = parseTransactionMessage(wrapTransaction(messageBytes));

    expect(parsed.isVersioned).toBe(false);
    expect(parsed.header).toEqual({ numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 });
    expect(parsed.staticAccountKeys).toEqual([signer, programId]);
    expect(parsed.recentBlockhash).toBe(recentBlockhash);
    expect(parsed.instructions).toHaveLength(1);
    expect(parsed.instructions[0].programIdIndex).toBe(1);
    expect(parsed.instructions[0].accountIndexes).toEqual([0]);
    expect(Buffer.from(parsed.instructions[0].data)).toEqual(Buffer.from([0xde, 0xad]));
    expect(parsed.addressTableLookups).toEqual([]);
  });

  it('round-trips a v0 message with address-table lookups', () => {
    const signer = generateSolanaWallet().address;
    const programId = generateSolanaWallet().address;
    const recentBlockhash = generateSolanaWallet().address;
    const altAddress = generateSolanaWallet().address;
    const messageBytes = buildMessageBytes({
      versioned: true,
      accountKeys: [signer, programId],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      recentBlockhash,
      instructions: [{ programIdIndex: 1, accountIndexes: [0, 2], data: Buffer.from([0x01]) }],
      addressTableLookups: [{ lookupTableAddress: altAddress, writableIndexes: [5], readonlyIndexes: [] }],
    });
    const parsed = parseTransactionMessage(wrapTransaction(messageBytes));

    expect(parsed.isVersioned).toBe(true);
    expect(parsed.addressTableLookups).toEqual([{ lookupTableAddress: altAddress, writableIndexes: [5], readonlyIndexes: [] }]);
    // Account index 2 is beyond the 2 static keys — only resolvable via the ALT above.
    expect(resolveStaticAccount(parsed, 0)).toBe(signer);
    expect(resolveStaticAccount(parsed, 2)).toBe(null);
  });

  it('throws on a truncated transaction rather than silently misparsing', () => {
    const signer = generateSolanaWallet().address;
    const programId = generateSolanaWallet().address;
    const recentBlockhash = generateSolanaWallet().address;
    const messageBytes = buildMessageBytes({
      versioned: false,
      accountKeys: [signer, programId],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      recentBlockhash,
      instructions: [{ programIdIndex: 1, accountIndexes: [0], data: Buffer.from([0xde, 0xad]) }],
    });
    const full = Buffer.from(wrapTransaction(messageBytes), 'base64');
    // Cut the buffer partway through the account-key section: a naive parser
    // would read `undefined` bytes and drift its offset; this one must fail closed.
    const truncated = full.subarray(0, full.length - 40).toString('base64');
    expect(() => parseTransactionMessage(truncated)).toThrow(/past end of buffer/);
  });

  it('fails closed on an unsupported transaction version rather than parsing it as v0', () => {
    // A versioned prefix whose low 7 bits are non-zero (here version 1, 0x81).
    // Only legacy and v0 exist today; the rest of the parser assumes the v0
    // layout, so an unknown version must be rejected, not skipped and misparsed.
    const signer = generateSolanaWallet().address;
    const programId = generateSolanaWallet().address;
    const recentBlockhash = generateSolanaWallet().address;
    const messageBytes = buildMessageBytes({
      versioned: true,
      versionByte: 0x81,
      accountKeys: [signer, programId],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      recentBlockhash,
      instructions: [{ programIdIndex: 1, accountIndexes: [0], data: Buffer.from([0x01]) }],
    });
    expect(() => parseTransactionMessage(wrapTransaction(messageBytes)))
      .toThrow(/Unsupported Solana transaction version 1/);
  });

  it('decodes a real base58 pubkey identically to the existing wallet helper', () => {
    // Sanity check against a known-good encode/decode pair rather than relying
    // solely on this module's own round-trip.
    const wallet = generateSolanaWallet();
    const messageBytes = buildMessageBytes({
      versioned: false,
      accountKeys: [wallet.address],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
      recentBlockhash: wallet.address,
      instructions: [],
    });
    const parsed = parseTransactionMessage(wrapTransaction(messageBytes));
    expect(base58Encode(base58Decode(parsed.staticAccountKeys[0]))).toBe(wallet.address);
  });
});
