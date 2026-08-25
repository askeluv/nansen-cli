/**
 * Nansen CLI - Solana Transaction Deserialization
 * Parses a serialized (legacy or v0) Solana VersionedTransaction so its
 * instructions can be statically inspected before signing.
 */

import { base58Encode } from './wallet.js';

function readCompactU16(buf, offset) {
  let value = 0;
  let shift = 0;
  let size = 0;
  for (let i = 0; i < 3; i++) {
    if (offset + i >= buf.length) {
      throw new Error('Malformed Solana transaction: compact-u16 length runs past end of buffer');
    }
    const byte = buf[offset + i];
    value |= (byte & 0x7f) << shift;
    size++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, size };
}

/**
 * Parse a base64-encoded Solana transaction (wire format:
 * [compact-u16 sigCount][sigCount * 64-byte signatures][message]) into its
 * header, static account keys, instructions, and (v0 only) address-table
 * lookups. `data` on instructions is returned undecoded (raw Buffer).
 */
export function parseTransactionMessage(base64) {
  const bytes = Buffer.from(base64, 'base64');
  // Fail closed on any read past the end of the buffer: a truncated or crafted
  // transaction must throw here rather than silently misparse into a wrong
  // (possibly drain-hiding) instruction list before signing.
  const requireBytes = (off, need) => {
    if (off + need > bytes.length) {
      throw new Error('Malformed Solana transaction: read past end of buffer');
    }
  };
  const { value: numSignatures, size: sigCountSize } = readCompactU16(bytes, 0);
  let offset = sigCountSize + numSignatures * 64;

  requireBytes(offset, 1);
  const first = bytes[offset];
  const isVersioned = (first & 0x80) !== 0;
  if (isVersioned) offset += 1; // skip the version-prefix byte; header follows

  requireBytes(offset, 3);
  const numRequiredSignatures = bytes[offset];
  const numReadonlySignedAccounts = bytes[offset + 1];
  const numReadonlyUnsignedAccounts = bytes[offset + 2];
  offset += 3;

  const { value: numAccountKeys, size: keysCountSize } = readCompactU16(bytes, offset);
  offset += keysCountSize;
  const staticAccountKeys = [];
  for (let i = 0; i < numAccountKeys; i++) {
    requireBytes(offset, 32);
    staticAccountKeys.push(base58Encode(bytes.subarray(offset, offset + 32)));
    offset += 32;
  }

  requireBytes(offset, 32);
  const recentBlockhash = base58Encode(bytes.subarray(offset, offset + 32));
  offset += 32;

  const { value: numInstructions, size: ixCountSize } = readCompactU16(bytes, offset);
  offset += ixCountSize;
  const instructions = [];
  for (let i = 0; i < numInstructions; i++) {
    requireBytes(offset, 1);
    const programIdIndex = bytes[offset];
    offset += 1;
    const { value: numAccounts, size: accCountSize } = readCompactU16(bytes, offset);
    offset += accCountSize;
    requireBytes(offset, numAccounts);
    const accountIndexes = [];
    for (let j = 0; j < numAccounts; j++) {
      accountIndexes.push(bytes[offset]);
      offset += 1;
    }
    const { value: dataLen, size: dataLenSize } = readCompactU16(bytes, offset);
    offset += dataLenSize;
    requireBytes(offset, dataLen);
    const data = bytes.subarray(offset, offset + dataLen);
    offset += dataLen;
    instructions.push({ programIdIndex, accountIndexes, data });
  }

  const addressTableLookups = [];
  if (isVersioned) {
    const { value: numLookups, size: lookupCountSize } = readCompactU16(bytes, offset);
    offset += lookupCountSize;
    for (let i = 0; i < numLookups; i++) {
      requireBytes(offset, 32);
      const lookupTableAddress = base58Encode(bytes.subarray(offset, offset + 32));
      offset += 32;
      const { value: numWritable, size: writableCountSize } = readCompactU16(bytes, offset);
      offset += writableCountSize;
      requireBytes(offset, numWritable);
      const writableIndexes = [];
      for (let j = 0; j < numWritable; j++) {
        writableIndexes.push(bytes[offset]);
        offset += 1;
      }
      const { value: numReadonly, size: readonlyCountSize } = readCompactU16(bytes, offset);
      offset += readonlyCountSize;
      requireBytes(offset, numReadonly);
      const readonlyIndexes = [];
      for (let j = 0; j < numReadonly; j++) {
        readonlyIndexes.push(bytes[offset]);
        offset += 1;
      }
      addressTableLookups.push({ lookupTableAddress, writableIndexes, readonlyIndexes });
    }
  }

  return {
    isVersioned,
    header: { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts },
    staticAccountKeys,
    recentBlockhash,
    instructions,
    addressTableLookups,
  };
}

/**
 * Resolve an account index to its base58 pubkey, or null if it's only
 * resolvable via an address-lookup-table entry (requires an RPC fetch this
 * module intentionally doesn't make). Lookup-table entries can never be
 * signers — Solana's message format requires every signer to be a static
 * account key — so a null result here only ever means "not a signer, and
 * this specific pubkey can't be verified without a network call."
 */
export function resolveStaticAccount(parsed, index) {
  if (index < parsed.staticAccountKeys.length) return parsed.staticAccountKeys[index];
  return null;
}

export function isSignerIndex(parsed, index) {
  return index < parsed.header.numRequiredSignatures;
}
