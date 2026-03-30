/**
 * Nansen CLI - x402 Solana Auto-Payment
 * Implements SPL TransferChecked transaction building for x402 payments.
 */

import crypto from 'crypto';
import { base58Encode, base58Decode, base58DecodePubkey } from './wallet.js';

// ============= Constants =============

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const _TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const _SYSTEM_PROGRAM = '11111111111111111111111111111111';

const DEFAULT_COMPUTE_UNIT_LIMIT = 20000;
const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1;

// ============= Compact-u16 Encoding =============
// (Solana's variable-length integer format, from trading.js pattern)

export function encodeCompactU16(value) {
  if (value < 0x80) return Buffer.from([value]);
  if (value < 0x4000) return Buffer.from([
    (value & 0x7f) | 0x80,
    (value >> 7) & 0x7f,
  ]);
  return Buffer.from([
    (value & 0x7f) | 0x80,
    ((value >> 7) & 0x7f) | 0x80,
    (value >> 14) & 0x03,
  ]);
}

// ============= PDA Derivation =============

/**
 * Derive Associated Token Account (ATA) address.
 * PDA seeds: [owner, tokenProgram, mint] with ATA program.
 */
export function deriveATA(ownerBase58, mintBase58, tokenProgramBase58 = TOKEN_PROGRAM) {
  const owner = base58DecodePubkey(ownerBase58);
  const tokenProgram = base58DecodePubkey(tokenProgramBase58);
  const mint = base58DecodePubkey(mintBase58);
  const ataProgramKey = base58DecodePubkey(ATA_PROGRAM);

  // find_program_address: try nonce 255 down to 0
  // PDA = SHA256(seeds... || programId || "ProgramDerivedAddress")
  // A valid PDA must NOT be on the ed25519 curve.
  // Checking on-curve in pure JS without a full ed25519 implementation is hard.
  // We use the mathematical approach: decode y-coordinate, compute x², check QR.
  for (let nonce = 255; nonce >= 0; nonce--) {
    const hash = crypto.createHash('sha256')
      .update(Buffer.concat([owner, tokenProgram, mint, Buffer.from([nonce]), ataProgramKey, Buffer.from('ProgramDerivedAddress')]))
      .digest();

    if (!isOnCurve(hash)) {
      return base58Encode(hash);
    }
  }
  throw new Error('Could not derive ATA: no valid PDA found');
}

/**
 * Check if a 32-byte buffer represents a valid ed25519 curve point.
 * Ed25519 curve: -x² + y² = 1 + d*x²*y²  over GF(p) where p = 2^255 - 19
 * 
 * Decode y from the 32 bytes, compute x² = (y² - 1) / (d*y² + 1),
 * then check if x² is a quadratic residue (QR) mod p.
 */
function isOnCurve(bytes) {
  const p = (1n << 255n) - 19n;
  const d = -121665n * modInverse(121666n, p) % p;

  // Read y-coordinate (little-endian, clear top bit which is sign of x)
  let y = 0n;
  for (let i = 0; i < 32; i++) {
    y |= BigInt(bytes[i]) << (BigInt(i) * 8n);
  }
  y &= (1n << 255n) - 1n; // Clear top bit

  if (y >= p) return false;

  // y² mod p
  const y2 = modPow(y, 2n, p);
  
  // x² = (y² - 1) * inverse(d*y² + 1) mod p
  const num = ((y2 - 1n) % p + p) % p;
  const den = ((d * y2 + 1n) % p + p) % p;
  const denInv = modInverse(den, p);
  if (denInv === null) return false;
  
  const x2 = (num * denInv) % p;
  
  // Check if x² is a quadratic residue: x^((p-1)/2) == 1 mod p
  if (x2 === 0n) return true;
  const euler = modPow(x2, (p - 1n) / 2n, p);
  return euler === 1n;
}

function modPow(base, exp, mod) {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function modInverse(a, mod) {
  return modPow(((a % mod) + mod) % mod, mod - 2n, mod);
}

// ============= MessageV0 Builder =============

/**
 * Build a Solana MessageV0 from accounts and instructions.
 * Simplified builder for x402 payment transactions.
 */
function buildMessageV0({ feePayer, instructions, recentBlockhash, accounts: _accounts }) {
  // All unique accounts in order: feePayer first, then signers, then rest
  const accountMap = new Map();
  const feePayerKey = feePayer;

  // feePayer is always first, always writable + signer
  accountMap.set(feePayerKey, { isSigner: true, isWritable: true });

  // Collect all accounts from instructions
  for (const ix of instructions) {
    if (!accountMap.has(ix.programId)) {
      accountMap.set(ix.programId, { isSigner: false, isWritable: false });
    }
    for (const acc of ix.accounts) {
      const existing = accountMap.get(acc.pubkey);
      if (existing) {
        existing.isSigner = existing.isSigner || acc.isSigner;
        existing.isWritable = existing.isWritable || acc.isWritable;
      } else {
        accountMap.set(acc.pubkey, { isSigner: acc.isSigner, isWritable: acc.isWritable });
      }
    }
  }

  // Sort: signers+writable, signers+readonly, non-signer+writable, non-signer+readonly
  // feePayer always at index 0
  const sortedKeys = [feePayerKey];
  const rest = [...accountMap.entries()].filter(([k]) => k !== feePayerKey);

  // Signer+writable
  for (const [k, v] of rest) if (v.isSigner && v.isWritable) sortedKeys.push(k);
  // Signer+readonly
  for (const [k, v] of rest) if (v.isSigner && !v.isWritable) sortedKeys.push(k);
  // Non-signer+writable
  for (const [k, v] of rest) if (!v.isSigner && v.isWritable) sortedKeys.push(k);
  // Non-signer+readonly
  for (const [k, v] of rest) if (!v.isSigner && !v.isWritable) sortedKeys.push(k);

  // Count header values
  let numRequiredSignatures = 0;
  let numReadonlySignedAccounts = 0;
  let numReadonlyUnsignedAccounts = 0;

  for (const key of sortedKeys) {
    const meta = accountMap.get(key);
    if (meta.isSigner) {
      numRequiredSignatures++;
      if (!meta.isWritable) numReadonlySignedAccounts++;
    } else {
      if (!meta.isWritable) numReadonlyUnsignedAccounts++;
    }
  }

  // Build the account keys index
  const keyIndex = new Map();
  sortedKeys.forEach((k, i) => keyIndex.set(k, i));

  // Compile instructions
  const compiledInstructions = instructions.map(ix => {
    const programIdIndex = keyIndex.get(ix.programId);
    const accountIndices = ix.accounts.map(a => keyIndex.get(a.pubkey));
    return { programIdIndex, accountIndices, data: ix.data };
  });

  // Serialize MessageV0
  // Format: prefix(0x80) | header(3 bytes) | staticAccountKeys | recentBlockhash | instructions | addressTableLookups
  const parts = [];

  // Version prefix (0x80 = v0)
  parts.push(Buffer.from([0x80]));

  // Header: numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts
  parts.push(Buffer.from([numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts]));

  // Static account keys
  parts.push(encodeCompactU16(sortedKeys.length));
  for (const key of sortedKeys) {
    parts.push(base58DecodePubkey(key));
  }

  // Recent blockhash (32 bytes)
  parts.push(base58DecodePubkey(recentBlockhash));

  // Instructions
  parts.push(encodeCompactU16(compiledInstructions.length));
  for (const ix of compiledInstructions) {
    parts.push(Buffer.from([ix.programIdIndex]));
    parts.push(encodeCompactU16(ix.accountIndices.length));
    for (const idx of ix.accountIndices) {
      parts.push(Buffer.from([idx]));
    }
    parts.push(encodeCompactU16(ix.data.length));
    parts.push(ix.data);
  }

  // Address table lookups (empty for our use case)
  parts.push(encodeCompactU16(0));

  return Buffer.concat(parts);
}

// ============= Ed25519 Signing =============

/**
 * Sign a message with Ed25519 using a Solana keypair (64 bytes: seed + pubkey).
 */
function signEd25519(message, keypairHex) {
  const seed = Buffer.from(keypairHex.slice(0, 64), 'hex'); // First 32 bytes
  const keyObj = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 Ed25519 prefix
      seed,
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.sign(null, message, keyObj);
}

// ============= x402 Solana Payment =============

/**
 * Build an unsigned Solana x402 payment transaction.
 * Returns the serialized MessageV0 bytes and the full transaction bytes
 * (with both signature slots as 64 zero bytes).
 *
 * Used by local-key signing (createSvmPaymentPayload) and Privy server wallet signing.
 */
export function buildUnsignedSvmTransaction(
  requirements,
  walletAddress,
  recentBlockhash,
  decimals = 6,
  tokenProgram = TOKEN_PROGRAM,
) {
  const extra = requirements.extra || {};
  const feePayerStr = extra.feePayer;
  if (!feePayerStr) {
    throw new Error('feePayer is required in requirements.extra for SVM transactions');
  }

  const mint = requirements.asset;
  const amount = BigInt(requirements.amount);
  const payTo = requirements.pay_to || requirements.payTo;

  // Derive ATAs
  const sourceATA = deriveATA(walletAddress, mint, tokenProgram);
  const destATA = deriveATA(payTo, mint, tokenProgram);

  // Build instructions
  // 1. SetComputeUnitLimit: [2, u32 LE]
  const cuLimitData = Buffer.alloc(5);
  cuLimitData[0] = 2;
  cuLimitData.writeUInt32LE(DEFAULT_COMPUTE_UNIT_LIMIT, 1);

  // 2. SetComputeUnitPrice: [3, u64 LE]
  const cuPriceData = Buffer.alloc(9);
  cuPriceData[0] = 3;
  cuPriceData.writeBigUInt64LE(BigInt(DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS), 1);

  // 3. TransferChecked: [12, u64 amount LE, u8 decimals]
  const transferData = Buffer.alloc(10);
  transferData[0] = 12;
  transferData.writeBigUInt64LE(amount, 1);
  transferData[9] = decimals;

  // 4. Memo: random 16 bytes hex for nonce
  const memoData = Buffer.from(crypto.randomBytes(16).toString('hex'));

  const instructions = [
    {
      programId: COMPUTE_BUDGET_PROGRAM,
      accounts: [],
      data: cuLimitData,
    },
    {
      programId: COMPUTE_BUDGET_PROGRAM,
      accounts: [],
      data: cuPriceData,
    },
    {
      programId: tokenProgram,
      accounts: [
        { pubkey: sourceATA, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: destATA, isSigner: false, isWritable: true },
        { pubkey: walletAddress, isSigner: true, isWritable: false },
      ],
      data: transferData,
    },
    {
      programId: MEMO_PROGRAM,
      accounts: [],
      data: memoData,
    },
  ];

  const messageBytes = buildMessageV0({
    feePayer: feePayerStr,
    instructions,
    recentBlockhash,
    accounts: null,
  });

  // Build transaction: compact-u16(numSignatures) + signatures + message
  // 2 signatures: [facilitator placeholder (64 zero bytes), client placeholder (64 zero bytes)]
  const numSigs = encodeCompactU16(2);
  const txBytes = Buffer.concat([
    numSigs,
    Buffer.alloc(64), // facilitator placeholder
    Buffer.alloc(64), // client placeholder
    messageBytes,
  ]);

  return { messageBytes, txBase64: txBytes.toString('base64') };
}

/**
 * Build a signed Solana x402 payment transaction using a local Ed25519 keypair.
 * Calls buildUnsignedSvmTransaction internally, then signs with the private key.
 *
 * @returns {string} Base64-encoded PaymentPayload JSON for Payment-Signature header
 */
export function createSvmPaymentPayload(
  requirements,
  keypairHex,
  walletAddress,
  resource,
  recentBlockhash,
  decimals = 6,
  tokenProgram = TOKEN_PROGRAM,
) {
  const { messageBytes } = buildUnsignedSvmTransaction(
    requirements,
    walletAddress,
    recentBlockhash,
    decimals,
    tokenProgram,
  );

  // Sign: client signs the full message (with 0x80 version prefix already included)
  const clientSignature = signEd25519(messageBytes, keypairHex);

  // Rebuild transaction with the real client signature at slot 1
  const numSigs = encodeCompactU16(2);
  const txBytes = Buffer.concat([
    numSigs,
    Buffer.alloc(64), // facilitator placeholder
    clientSignature,
    messageBytes,
  ]);

  const txBase64 = txBytes.toString('base64');

  // Build x402 payload (camelCase per x402 spec)
  const payload = {
    x402Version: 2,
    payload: { transaction: txBase64 },
    accepted: requirements,
  };

  if (resource) {
    payload.resource = { url: resource };
  }

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Fetch recent blockhash from Solana RPC.
 */
export async function fetchRecentBlockhash(rpcUrl = 'https://api.mainnet-beta.solana.com') {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLatestBlockhash',
      params: [{ commitment: 'finalized' }],
    }),
  });
  const data = await response.json();
  return data.result.value.blockhash;
}

/**
 * Get RPC URL for a Solana network identifier.
 */
export function getSolanaRpcUrl(network) {
  if (network.includes('devnet') || network === 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1') {
    return 'https://api.devnet.solana.com';
  }
  if (network.includes('testnet') || network === 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z') {
    return 'https://api.testnet.solana.com';
  }
  return 'https://api.mainnet-beta.solana.com';
}

/**
 * Check if a network string is a Solana network.
 */
export function isSvmNetwork(network) {
  return typeof network === 'string' && network.startsWith('solana:');
}
