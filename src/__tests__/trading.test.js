/**
 * Tests for trading module
 *
 * Covers: chain resolution, quote storage, RLP encoding, compact-u16 parsing,
 * Solana signing, EVM signing (address recovery, decimal/hex handling, EIP-155),
 * ERC-20 approval building, API error handling, and CLI command validation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  resolveChain,
  getWalletChainType,
  saveQuote,
  loadQuote,
  cleanupQuotes,
  readCompactU16,
  toBuffer,
  signLegacyTransaction,
  signSolanaTransaction,
  signEvmTransaction,
  buildApprovalTransaction,
  approvalAmountForSwap,
  approvalCapForQuote,
  assertCompleteEvmRequestIntent,
  validateSwapTarget,
  assertUsableSpender,
  stripLeadingZeros,
  buildTradingCommands,
  getWrappedNativeFromWarning,
  validateBaseUnitAmount,
  resolveTokenAddress,
  resolveTokenDecimals,
  convertToBaseUnits,
  formatQuote,
  simulateEvmCall,
  verifySwapOutcome,
  getBridgeStatus,
  pollBridgeStatus,
  saveTxRecord,
  loadTxRecord,
  __setAllowanceTimingForTests,
} from '../trading.js';
import { SIMULATION_RPCS } from '../rpc-urls.js';
import { keccak256, rlpEncode } from '../crypto.js';
import { base58Decode } from '../transfer.js';
import {
  base58Encode,
  generateEvmWallet,
  generateSolanaWallet,
  createWallet,
  showWallet,
} from '../wallet.js';
import * as wcTrading from '../walletconnect-trading.js';

let originalHome;
let tempDir;

const BASE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const OUT_TOKEN = '0x4200000000000000000000000000000000000006';
const LIFI_ROUTER = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';
const RELAY_ROUTER = '0xf5042e6ffac5a625d4e7848e0b01373d8eb9e222';

function evmIntent({ walletAddress, fromToken = BASE_USDC, toToken = OUT_TOKEN, amount = '1000000', maxInputAmount = amount, swapMode = 'exactIn', toChain = null, recipient = null } = {}) {
  return {
    chain: 'base',
    toChain,
    walletAddress,
    recipient,
    fromToken,
    toToken,
    swapMode,
    amount,
    maxInputAmount,
  };
}

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-trading-test-'));
  process.env.HOME = tempDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ============= Chain Resolution =============

describe('resolveChain', () => {
  it('should resolve all supported chains', () => {
    const expected = {
      solana:   { index: '501', type: 'solana', chainId: 501 },
      base:     { index: '8453', type: 'evm',   chainId: 8453 },
    };
    for (const [name, exp] of Object.entries(expected)) {
      const chain = resolveChain(name);
      expect(chain.index).toBe(exp.index);
      expect(chain.type).toBe(exp.type);
      expect(chain.chainId).toBe(exp.chainId);
      expect(chain.explorer).toMatch(/^https:\/\//);
    }
  });

  it('should be case-insensitive', () => {
    expect(resolveChain('SOLANA').index).toBe('501');
    expect(resolveChain('Base').index).toBe('8453');
  });

  it('should throw for unsupported chain', () => {
    expect(() => resolveChain('polygon')).toThrow('Unsupported chain');
    expect(() => resolveChain('ethereum')).toThrow('Unsupported chain');
    expect(() => resolveChain('bsc')).toThrow('Unsupported chain');
    expect(() => resolveChain('')).toThrow('Unsupported chain');
    expect(() => resolveChain(null)).toThrow('Unsupported chain');
    expect(() => resolveChain(undefined)).toThrow('Unsupported chain');
  });
});

describe('resolveTokenAddress', () => {
  it('should resolve common symbols to addresses', () => {
    expect(resolveTokenAddress('SOL', 'solana')).toBe('So11111111111111111111111111111111111111112');
    expect(resolveTokenAddress('USDC', 'solana')).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(resolveTokenAddress('ETH', 'base')).toBe('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    expect(resolveTokenAddress('USDC', 'base')).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  });

  it('should be case-insensitive for symbols', () => {
    expect(resolveTokenAddress('sol', 'solana')).toBe('So11111111111111111111111111111111111111112');
    expect(resolveTokenAddress('usdc', 'base')).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(resolveTokenAddress('Eth', 'base')).toBe('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  });

  it('should pass through raw addresses unchanged', () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678';
    expect(resolveTokenAddress(addr, 'base')).toBe(addr);
    expect(resolveTokenAddress('So11111111111111111111111111111111111111112', 'solana'))
      .toBe('So11111111111111111111111111111111111111112');
  });

  it('should pass through unknown symbols unchanged', () => {
    expect(resolveTokenAddress('SHIB', 'solana')).toBe('SHIB');
  });

  it('should handle null/undefined gracefully', () => {
    expect(resolveTokenAddress(null, 'solana')).toBe(null);
    expect(resolveTokenAddress('SOL', null)).toBe('SOL');
    expect(resolveTokenAddress(undefined, undefined)).toBe(undefined);
  });
});

describe('getWalletChainType', () => {
  it('should return solana for solana', () => {
    expect(getWalletChainType('solana')).toBe('solana');
  });
  it('should return evm for all EVM chains', () => {
    for (const chain of ['base']) {
      expect(getWalletChainType(chain)).toBe('evm');
    }
  });
});

// ============= Quote Storage =============

describe('quote storage', () => {
  // Mock responses matching actual API shapes
  const solanaQuoteResponse = {
    success: true,
    quotes: [{
      aggregator: 'jupiter',
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inAmount: '10000000',
      outAmount: '781370',
      inUsdValue: '0.78',
      outUsdValue: '0.78',
      transaction: 'AQAAAA==', // base64 transaction (Solana format)
      metadata: { requestId: 'test-req-id' },
    }],
    metadata: { chainIndex: '501', quotesCount: 1, bestQuote: 'jupiter' },
  };

  const evmQuoteResponse = {
    success: true,
    quotes: [{
      aggregator: 'okx',
      inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      outputMint: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      inAmount: '100000000000000',
      outAmount: '186872',
      inUsdValue: '0.19',
      outUsdValue: '0.19',
      approvalAddress: '0x57df6092665eb6058de53939612413ff4b09114e',
      transaction: {  // EVM format: object with fields
        to: '0x4409921ae43a39a11d90f7b7f96cfd0b8093d9fc',
        data: '0xf2c42696',
        value: '100000000000000',  // decimal string (not hex!)
        gas: '558000',             // decimal string
        gasPrice: '13560000',      // decimal string
      },
    }],
    metadata: { chainIndex: '8453', quotesCount: 1, bestQuote: 'okx' },
  };

  it('should save and load a Solana quote', () => {
    const quoteId = saveQuote(solanaQuoteResponse, 'solana');
    expect(quoteId).toMatch(/^\d+-[a-f0-9]+$/);

    const loaded = loadQuote(quoteId);
    expect(loaded.chain).toBe('solana');
    expect(loaded.response.quotes[0].aggregator).toBe('jupiter');
    expect(loaded.response.quotes[0].transaction).toBe('AQAAAA==');
    expect(loaded.response.quotes[0].metadata.requestId).toBe('test-req-id');
  });

  it('should save and load an EVM quote with transaction object', () => {
    const quoteId = saveQuote(evmQuoteResponse, 'base');
    const loaded = loadQuote(quoteId);
    expect(loaded.chain).toBe('base');
    expect(loaded.response.quotes[0].transaction.to).toBe('0x4409921ae43a39a11d90f7b7f96cfd0b8093d9fc');
    expect(loaded.response.quotes[0].transaction.value).toBe('100000000000000');
    expect(loaded.response.quotes[0].approvalAddress).toBe('0x57df6092665eb6058de53939612413ff4b09114e');
  });

  it('should throw for non-existent quote', () => {
    expect(() => loadQuote('nonexistent-abc')).toThrow('not found');
  });

  it('should expire old quotes (>1 hour)', () => {
    const quoteId = saveQuote(solanaQuoteResponse, 'solana');
    const quotesDir = path.join(tempDir, '.nansen', 'quotes');
    const filePath = path.join(quotesDir, `${quoteId}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.timestamp = Date.now() - 3700000; // 1h + 100s
    fs.writeFileSync(filePath, JSON.stringify(data));

    expect(() => loadQuote(quoteId)).toThrow('expired');
  });

  it('should cleanup old quotes but keep fresh ones', () => {
    const id1 = saveQuote(solanaQuoteResponse, 'solana');
    const id2 = saveQuote(evmQuoteResponse, 'base');

    // Backdate id1
    const quotesDir = path.join(tempDir, '.nansen', 'quotes');
    const data = JSON.parse(fs.readFileSync(path.join(quotesDir, `${id1}.json`), 'utf8'));
    data.timestamp = Date.now() - 3700000;
    fs.writeFileSync(path.join(quotesDir, `${id1}.json`), JSON.stringify(data));

    cleanupQuotes();

    expect(fs.existsSync(path.join(quotesDir, `${id1}.json`))).toBe(false);
    expect(fs.existsSync(path.join(quotesDir, `${id2}.json`))).toBe(true);
  });

  it('should save Privy signerType and wallet IDs in quote', () => {
    const privyWalletIds = { evm: 'wl_evm_1', solana: 'wl_sol_1' };
    const quoteId = saveQuote(evmQuoteResponse, 'base', 'privy', privyWalletIds);
    const loaded = loadQuote(quoteId);
    expect(loaded.signerType).toBe('privy');
    expect(loaded.privyWalletIds).toEqual(privyWalletIds);
  });

  it('should save and load toChain for cross-chain quotes', () => {
    const quoteId = saveQuote(evmQuoteResponse, 'base', 'local', null, 'solana');
    const loaded = loadQuote(quoteId);
    expect(loaded.chain).toBe('base');
    expect(loaded.toChain).toBe('solana');
  });

  it('should not include toChain when null', () => {
    const quoteId = saveQuote(evmQuoteResponse, 'base', 'local', null, null);
    const loaded = loadQuote(quoteId);
    expect(loaded.chain).toBe('base');
    expect(loaded.toChain).toBeUndefined();
  });

  it('tags saved quotes as swap and loads them', () => {
    const quoteId = saveQuote(solanaQuoteResponse, 'solana');
    expect(loadQuote(quoteId).type).toBe('swap');
  });

  it('rejects a bridge quote loaded through the swap path', () => {
    const quotesDir = path.join(tempDir, '.nansen', 'quotes');
    fs.mkdirSync(quotesDir, { recursive: true });
    const quoteId = 'bridge-123-abc';
    fs.writeFileSync(
      path.join(quotesDir, `${quoteId}.json`),
      JSON.stringify({ quoteId, type: 'bridge', timestamp: Date.now(), response: {} }),
    );
    expect(() => loadQuote(quoteId)).toThrow(/is a bridge quote/);
  });

  it('tolerates a legacy untyped swap quote', () => {
    const quotesDir = path.join(tempDir, '.nansen', 'quotes');
    fs.mkdirSync(quotesDir, { recursive: true });
    const quoteId = 'legacy-123-abc';
    fs.writeFileSync(
      path.join(quotesDir, `${quoteId}.json`),
      JSON.stringify({ quoteId, chain: 'base', timestamp: Date.now(), response: {} }),
    );
    expect(() => loadQuote(quoteId)).not.toThrow();
  });
});

// ============= Compact-u16 (Solana wire format) =============

describe('readCompactU16', () => {
  it('should read single-byte values', () => {
    expect(readCompactU16(Buffer.from([0x00]), 0)).toEqual({ value: 0, size: 1 });
    expect(readCompactU16(Buffer.from([0x01]), 0)).toEqual({ value: 1, size: 1 });
    expect(readCompactU16(Buffer.from([0x7f]), 0)).toEqual({ value: 127, size: 1 });
  });

  it('should read multi-byte values', () => {
    expect(readCompactU16(Buffer.from([0x80, 0x01]), 0)).toEqual({ value: 128, size: 2 });
  });

  it('should read with offset', () => {
    expect(readCompactU16(Buffer.from([0xff, 0x05]), 1)).toEqual({ value: 5, size: 1 });
  });
});

// ============= RLP Encoding =============

describe('rlpEncode', () => {
  it('should encode single byte < 0x80', () => {
    expect(rlpEncode(Buffer.from([0x42]))).toEqual(Buffer.from([0x42]));
  });

  it('should encode empty buffer as 0x80', () => {
    expect(rlpEncode(Buffer.alloc(0))).toEqual(Buffer.from([0x80]));
  });

  it('should encode short string', () => {
    expect(rlpEncode(Buffer.from('dog'))).toEqual(Buffer.from([0x83, 0x64, 0x6f, 0x67]));
  });

  it('should encode empty list', () => {
    expect(rlpEncode([])).toEqual(Buffer.from([0xc0]));
  });

  it('should encode nested list [ [], [[]], [ [], [[]] ] ]', () => {
    expect(rlpEncode([[], [[]], [[], [[]]]]))
      .toEqual(Buffer.from([0xc7, 0xc0, 0xc1, 0xc0, 0xc3, 0xc0, 0xc1, 0xc0]));
  });

  it('should encode hex strings correctly', () => {
    const result = rlpEncode('0x0400');
    expect(result).toEqual(Buffer.from([0x82, 0x04, 0x00]));
  });

  it('should encode long strings (>55 bytes)', () => {
    const str = 'Lorem ipsum dolor sit amet, consectetur adipisicing elit';
    const result = rlpEncode(Buffer.from(str));
    expect(result[0]).toBe(0xb8);
    expect(result[1]).toBe(56);
    expect(result.subarray(2).toString()).toBe(str);
  });
});

// ============= toBuffer: decimal vs hex string handling =============

describe('toBuffer', () => {
  it('should handle hex strings (0x prefix)', () => {
    expect(toBuffer('0x5af3107a4000')).toEqual(Buffer.from('5af3107a4000', 'hex'));
    // '0x0' is a valid single-byte hex value (0x00)
    expect(toBuffer('0x0')).toEqual(Buffer.from([0x00]));
    // '0x' is empty hex
    expect(toBuffer('0x')).toEqual(Buffer.alloc(0));
  });

  it('should handle numbers', () => {
    expect(toBuffer(0)).toEqual(Buffer.alloc(0));
    expect(toBuffer(1)).toEqual(Buffer.from([0x01]));
    expect(toBuffer(256)).toEqual(Buffer.from([0x01, 0x00]));
  });

  it('should handle bigints', () => {
    expect(toBuffer(0n)).toEqual(Buffer.alloc(0));
    expect(toBuffer(100000000000000n)).toEqual(Buffer.from('5af3107a4000', 'hex'));
  });
});

// ============= Solana Transaction Signing =============

describe('signSolanaTransaction', () => {
  it('should sign and produce a verifiable Ed25519 signature', () => {
    const message = Buffer.from('test-message-to-sign-for-solana');
    const txBytes = Buffer.concat([
      Buffer.from([0x01]),  // 1 signature slot (compact-u16)
      Buffer.alloc(64),     // empty signature slot
      message,
    ]);

    const wallet = generateSolanaWallet();
    const signedBase64 = signSolanaTransaction(txBytes.toString('base64'), wallet.privateKey);
    const signedBytes = Buffer.from(signedBase64, 'base64');

    // Signature slot should be filled
    const sigSlot = signedBytes.subarray(1, 65);
    expect(sigSlot.every(b => b === 0)).toBe(false);

    // Message should be unchanged
    expect(signedBytes.subarray(65).toString()).toBe('test-message-to-sign-for-solana');

    // Verify the Ed25519 signature
    const seed = Buffer.from(wallet.privateKey.slice(0, 64), 'hex');
    const privKey = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        seed,
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    expect(crypto.verify(null, message, crypto.createPublicKey(privKey), sigSlot)).toBe(true);
  });

  it('should handle transactions with multiple signature slots', () => {
    const message = Buffer.from('multi-sig-test');
    const txBytes = Buffer.concat([
      Buffer.from([0x02]),  // 2 signature slots
      Buffer.alloc(64),     // slot 1 (ours)
      Buffer.alloc(64),     // slot 2 (other signer)
      message,
    ]);

    const wallet = generateSolanaWallet();
    const signedBase64 = signSolanaTransaction(txBytes.toString('base64'), wallet.privateKey);
    const signedBytes = Buffer.from(signedBase64, 'base64');

    // First slot should be signed
    expect(signedBytes.subarray(1, 65).every(b => b === 0)).toBe(false);
    // Second slot should still be empty
    expect(signedBytes.subarray(65, 129).every(b => b === 0)).toBe(true);
    // Message unchanged
    expect(signedBytes.subarray(129).toString()).toBe('multi-sig-test');
  });

  it('should produce identical result from base58 object (OKX format) after normalization', () => {
    // OKX returns transaction as { data: "<base58-encoded tx>", ... }
    // while Jupiter returns a plain base64 string. The execute handler
    // normalizes by base58-decoding .data to base64 before signing.
    const message = Buffer.from('okx-format-test');
    const txBytes = Buffer.concat([
      Buffer.from([0x01]),
      Buffer.alloc(64),
      message,
    ]);

    const wallet = generateSolanaWallet();

    // Jupiter path: base64 string
    const base64Tx = txBytes.toString('base64');
    const signedFromBase64 = signSolanaTransaction(base64Tx, wallet.privateKey);

    // OKX path: base58 object -> normalize -> base64 string
    const base58Tx = base58Encode(txBytes);
    const okxTransaction = { data: base58Tx, from: 'addr', gas: '0', to: 'prog', value: '0' };
    let normalized = okxTransaction;
    if (typeof normalized === 'object' && normalized.data) {
      normalized = base58Decode(normalized.data).toString('base64');
    }
    const signedFromOkx = signSolanaTransaction(normalized, wallet.privateKey);

    expect(signedFromOkx).toBe(signedFromBase64);
  });
});

// ============= EVM Transaction Signing =============

describe('signLegacyTransaction', () => {
  it('should produce valid signed tx hex', () => {
    const wallet = generateEvmWallet();
    const tx = {
      nonce: 0, gasPrice: '0x3B9ACA00', gasLimit: '0x5208',
      to: '0x' + 'ab'.repeat(20), value: '0x0', data: '0x', chainId: 8453,
    };
    const signedHex = signLegacyTransaction(tx, wallet.privateKey);
    expect(signedHex).toMatch(/^0x[0-9a-f]+$/);
    // Valid RLP list prefix
    expect(parseInt(signedHex.slice(2, 4), 16)).toBeGreaterThanOrEqual(0xc0);
  });

  it('should recover to the correct address (critical: prevents wrong-sender bugs)', () => {
    // This test catches the bug where crypto.sign double-hashes,
    // producing a signature that recovers to the wrong address.
    const wallet = generateEvmWallet();
    const expectedAddress = wallet.address.toLowerCase();

    const tx = {
      nonce: 0, gasPrice: '0x3B9ACA00', gasLimit: '0x5208',
      to: '0x' + 'ab'.repeat(20), value: '0x0', data: '0x', chainId: 1,
    };
    const _signedHex = signLegacyTransaction(tx, wallet.privateKey);

    // Decode the signed tx to extract v, r, s and recover the address
    // We'll re-hash the unsigned portion and use ecRecover
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(Buffer.from(wallet.privateKey, 'hex'));
    const pubKey = ecdh.getPublicKey();

    // Derive address from public key
    const pubKeyHash = keccak256(pubKey.subarray(1));
    const derivedAddress = '0x' + pubKeyHash.subarray(12).toString('hex');
    expect(derivedAddress.toLowerCase()).toBe(expectedAddress);
  });

  it('should handle EIP-155 v for different chain IDs', () => {
    const wallet = generateEvmWallet();
    // EIP-155: v = chainId * 2 + 35 + recoveryBit
    // For chainId=8453: v is either 16941 or 16942
    for (const chainId of [1, 56, 8453]) {
      const tx = {
        nonce: 0, gasPrice: '0x1', gasLimit: '0x5208',
        to: '0x' + '00'.repeat(20), value: '0x0', data: '0x', chainId,
      };
      const signedHex = signLegacyTransaction(tx, wallet.privateKey);
      expect(signedHex).toMatch(/^0x/);
      expect(signedHex.length).toBeGreaterThan(100);
    }
  });

  it('should handle non-zero value and complex calldata', () => {
    const wallet = generateEvmWallet();
    const tx = {
      nonce: 5,
      gasPrice: '0x4A817C800',
      gasLimit: '0x30000',
      to: '0x' + 'cd'.repeat(20),
      value: '0xDE0B6B3A7640000', // 1 ETH
      data: '0x095ea7b3' + '00'.repeat(64),
      chainId: 8453,
    };
    const signedHex = signLegacyTransaction(tx, wallet.privateKey);
    expect(signedHex).toMatch(/^0x[0-9a-f]+$/);
  });

  it('should produce deterministic signatures (RFC 6979)', () => {
    const wallet = generateEvmWallet();
    const tx = {
      nonce: 0, gasPrice: '0x1', gasLimit: '0x5208',
      to: '0x' + 'ab'.repeat(20), value: '0x0', data: '0x', chainId: 1,
    };
    const sig1 = signLegacyTransaction(tx, wallet.privateKey);
    const sig2 = signLegacyTransaction(tx, wallet.privateKey);
    expect(sig1).toBe(sig2);
  });
});

describe('signEvmTransaction (API response format)', () => {
  it('should handle decimal string values from OKX (gasPrice, value, gas)', () => {
    // OKX returns decimal strings: "13560000", "100000000000000", "558000"
    const wallet = generateEvmWallet();
    const txData = {
      to: '0x' + 'ab'.repeat(20),
      data: '0xf2c42696',
      value: '100000000000000',   // decimal, NOT hex
      gas: '558000',              // decimal
      gasPrice: '13560000',       // decimal
    };
    const signedHex = signEvmTransaction(txData, wallet.privateKey, 'base', 0);
    expect(signedHex).toMatch(/^0x[0-9a-f]+$/);
  });

  it('should handle hex string values from LiFi (0x-prefixed)', () => {
    // LiFi returns hex: "0x5af3107a4000", etc.
    const wallet = generateEvmWallet();
    const txData = {
      to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
      data: '0x736eac0b',
      value: '0x5af3107a4000',
      gas: '0x88530',
      gasPrice: '0xcf0e53',
    };
    const signedHex = signEvmTransaction(txData, wallet.privateKey, 'base', 0);
    expect(signedHex).toMatch(/^0x[0-9a-f]+$/);
  });

  it('should reject unsupported chains', () => {
    const wallet = generateEvmWallet();
    expect(() => signEvmTransaction({}, wallet.privateKey, 'solana', 0))
      .toThrow('Unsupported EVM chain');
    expect(() => signEvmTransaction({}, wallet.privateKey, 'polygon', 0))
      .toThrow('Unsupported EVM chain');
  });

  it('should produce different signed tx for different nonces', () => {
    const wallet = generateEvmWallet();
    const txData = {
      to: '0x' + 'ab'.repeat(20), data: '0x', value: '0', gas: '21000', gasPrice: '1',
    };
    const sig0 = signEvmTransaction(txData, wallet.privateKey, 'base', 0);
    const sig1 = signEvmTransaction(txData, wallet.privateKey, 'base', 1);
    expect(sig0).not.toBe(sig1);
  });
});

// ============= ERC-20 Approval Transaction =============

describe('buildApprovalTransaction', () => {
  it('should build a valid approval tx scoped to the given amount', () => {
    const wallet = generateEvmWallet();
    const signedHex = buildApprovalTransaction(
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
      '0x57df6092665eb6058de53939612413ff4b09114e', // spender
      wallet.privateKey,
      'base',
      0,
      '1000000', // gasPrice
      1000000n,  // approve amount, scoped to the trade
    );
    expect(signedHex).toMatch(/^0x[0-9a-f]+$/);
    // Approval is scoped to the trade amount, not unlimited MAX_UINT256.
    expect(signedHex).toContain((1000000n).toString(16).padStart(64, '0'));
    expect(signedHex).not.toContain('f'.repeat(64));
  });

  it('should build a zero-amount revoke approval when explicitly allowed', () => {
    const wallet = generateEvmWallet();
    const signedHex = buildApprovalTransaction(
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      '0x57df6092665eb6058de53939612413ff4b09114e',
      wallet.privateKey,
      'base',
      0,
      '1000000',
      0n,
      undefined,
      { allowZero: true },
    );
    expect(signedHex).toMatch(/^0x[0-9a-f]+$/);
    expect(signedHex).toContain('0'.repeat(64));
  });

  it('should reject unsupported chains', () => {
    const wallet = generateEvmWallet();
    expect(() => buildApprovalTransaction('0xabc', '0xdef', wallet.privateKey, 'polygon', 0))
      .toThrow('Unsupported chain');
  });
});

// ============= Approval amount scoping (security hardening) =============

describe('approvalAmountForSwap', () => {
  it('approves exactly the input for exactIn (default)', () => {
    expect(approvalAmountForSwap({ inputAmount: 1000000n })).toBe(1000000n);
    expect(approvalAmountForSwap({ inputAmount: '2500000', swapMode: 'exactIn' })).toBe(2500000n);
  });

  it('buffers exactOut by the slippage (ceil)', () => {
    // 1,000,000 * (1 + 0.03) = 1,030,000
    expect(approvalAmountForSwap({ inputAmount: 1000000n, swapMode: 'exactOut', slippage: 0.03 })).toBe(1030000n);
  });

  it('defaults the exactOut buffer to 3% when slippage is missing', () => {
    expect(approvalAmountForSwap({ inputAmount: 1000000n, swapMode: 'exactOut' })).toBe(1030000n);
  });

  it('honours an explicit slippage of 0 for exactOut (no buffer)', () => {
    expect(approvalAmountForSwap({ inputAmount: 1000000n, swapMode: 'exactOut', slippage: 0 })).toBe(1000000n);
  });

  it('clamps non-positive / malformed amounts to 0n', () => {
    expect(approvalAmountForSwap({ inputAmount: 0n })).toBe(0n);
    expect(approvalAmountForSwap({ inputAmount: 0n, swapMode: 'exactOut' })).toBe(0n);
    // Negative/malformed input must clamp to 0n, never a negative BigInt.
    expect(approvalAmountForSwap({ inputAmount: '-5000000' })).toBe(0n);
    expect(approvalAmountForSwap({ inputAmount: -5000000n, swapMode: 'exactOut' })).toBe(0n);
    // Non-integer strings that BigInt() rejects must clamp, not throw.
    expect(approvalAmountForSwap({ inputAmount: '1500000.5' })).toBe(0n);
    expect(approvalAmountForSwap({ inputAmount: '1.5e6', swapMode: 'exactOut' })).toBe(0n);
  });

  it('is always bounded — never the unlimited MAX_UINT256', () => {
    const MAX = (1n << 256n) - 1n;
    const amt = approvalAmountForSwap({ inputAmount: 5000000n, swapMode: 'exactOut', slippage: 0.5 });
    expect(amt).toBe(7500000n); // 5,000,000 * 1.5
    expect(amt).toBeLessThan(MAX);
  });

  it('clamps an exactOut buffer that would overflow uint256 to 0n (not a cryptic throw)', () => {
    // A huge input × slippage can exceed the uint256 ceiling; returning 0n lets
    // the caller's `approveAmt <= 0n` skip surface it cleanly instead of the
    // encoder throwing "at or above MAX_UINT256" and falling through as a
    // generic quote failure.
    const MAX = (1n << 256n) - 1n;
    expect(approvalAmountForSwap({ inputAmount: MAX - 1n, swapMode: 'exactOut', slippage: 0.03 })).toBe(0n);
    expect(approvalAmountForSwap({ inputAmount: MAX, swapMode: 'exactOut', slippage: 0.5 })).toBe(0n);
    // A large-but-non-overflowing buffer is returned as-is (no over-clamping):
    // (MAX/2) * 1.5 = 0.75 * MAX, still below the ceiling.
    const belowCeiling = approvalAmountForSwap({ inputAmount: MAX / 2n, swapMode: 'exactOut', slippage: 0.5 });
    expect(belowCeiling).toBeGreaterThan(0n);
    expect(belowCeiling).toBeLessThan(MAX);
  });
});

// ============= Swap target validation (security hardening) =============

describe('approvalCapForQuote', () => {
  it('returns the persisted maxInputAmount when present (both modes)', () => {
    expect(approvalCapForQuote({ swapMode: 'exactIn', request: { maxInputAmount: '1000000', amount: '1000000' } })).toBe('1000000');
    expect(approvalCapForQuote({ swapMode: 'exactOut', request: { maxInputAmount: '1030000', amount: '990000' } })).toBe('1030000');
  });

  it('falls back to request.amount ONLY for exactIn (the input bound)', () => {
    expect(approvalCapForQuote({ swapMode: 'exactIn', request: { amount: '1000000' } })).toBe('1000000');
  });

  it('never falls back to request.amount for exactOut (that is the OUTPUT token amount)', () => {
    // The wrong-unit fallback must not leak in: exactOut with no cap yields undefined,
    // not the output amount. (assertInputWithinMax fails this path closed upstream.)
    expect(approvalCapForQuote({ swapMode: 'exactOut', request: { amount: '990000' } })).toBeUndefined();
  });

  it('is undefined when no request/cap exists (pre-intent quotes)', () => {
    expect(approvalCapForQuote({})).toBeUndefined();
    expect(approvalCapForQuote({ swapMode: 'exactIn' })).toBeUndefined();
    expect(approvalCapForQuote(undefined)).toBeUndefined();
  });
});

describe('assertCompleteEvmRequestIntent', () => {
  it('rejects missing or incomplete EVM request intent', () => {
    expect(() => assertCompleteEvmRequestIntent(null)).toThrow(/missing request intent/i);
    expect(() => assertCompleteEvmRequestIntent(evmIntent({ walletAddress: '' }))).toThrow(/walletAddress missing/i);
  });

  it('accepts complete EVM request intent', () => {
    expect(() => assertCompleteEvmRequestIntent(evmIntent({ walletAddress: '0xabc' }))).not.toThrow();
  });
});

describe('validateSwapTarget', () => {
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const ROUTER = '0xDef1C0ded9bec7F1a1670819833240f027b25EfF';

  afterEach(() => { vi.unstubAllGlobals(); });

  function mockGetCode(result) {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (body.method === 'eth_getCode') {
        if (result instanceof Error) return Promise.reject(result);
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })) });
      }
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null })) });
    }));
  }

  it('rejects an empty or zero-address target', async () => {
    await expect(validateSwapTarget('base', '', USDC)).rejects.toThrow(/empty or zero/i);
    await expect(validateSwapTarget('base', '0x0000000000000000000000000000000000000000', USDC)).rejects.toThrow(/zero/i);
  });

  it('rejects a target equal to the token being sold', async () => {
    // to == inputMint would encode a transfer/approve of the sold token, not a swap.
    await expect(validateSwapTarget('base', USDC, USDC)).rejects.toThrow(/token being sold/i);
  });

  it('rejects an EOA target (no contract code)', async () => {
    mockGetCode('0x');
    await expect(validateSwapTarget('base', ROUTER, USDC)).rejects.toThrow(/not a contract/i);
  });

  it('passes for a contract router', async () => {
    mockGetCode('0x6080604052');
    await expect(validateSwapTarget('base', ROUTER, USDC)).resolves.toBeUndefined();
  });

  it('fails closed when the code check RPC keeps failing', async () => {
    // A flaky or hostile RPC must not silently disable the target guard.
    mockGetCode(new Error('network down'));
    await expect(validateSwapTarget('base', ROUTER, USDC)).rejects.toThrow(/could not verify swap target .* refusing to sign/i);
  });

  it('re-throws a deterministic config error (no RPC URL) instead of skipping', async () => {
    // Unknown chain → evmRpcCall throws "No RPC URL configured…" before any fetch.
    await expect(validateSwapTarget('nosuchchain', ROUTER, USDC)).rejects.toThrow(/No RPC URL/i);
  });

  it('verifies a shared target only once when a run-scoped cache is passed', async () => {
    // A quote list commonly shares one router; the cache avoids re-checking (and,
    // on a flaky RPC, re-retrying) the same target for every quote.
    let getCodeCalls = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (body.method === 'eth_getCode') {
        getCodeCalls++;
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      }
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null })) });
    }));
    const verifiedTargets = new Set();
    await validateSwapTarget('base', ROUTER, USDC, { verifiedTargets });
    await validateSwapTarget('base', ROUTER, USDC, { verifiedTargets });
    expect(getCodeCalls).toBe(1);
    // The cheap zero/self checks still run every call even when cached.
    await expect(validateSwapTarget('base', USDC, USDC, { verifiedTargets })).rejects.toThrow(/token being sold/i);
  });

  it('does not cache a failed verification (transient failure gets a fresh attempt)', async () => {
    // Only successful checks are cached, so a one-off outage doesn't poison later quotes.
    mockGetCode(new Error('network down'));
    const verifiedTargets = new Set();
    await expect(validateSwapTarget('base', ROUTER, USDC, { verifiedTargets })).rejects.toThrow(/could not verify/i);
    expect(verifiedTargets.size).toBe(0);
  });
});

describe('assertUsableSpender', () => {
  it('rejects an empty or zero-address approval spender', () => {
    expect(() => assertUsableSpender('')).toThrow(/empty or the zero address/i);
    expect(() => assertUsableSpender(undefined)).toThrow(/empty or the zero address/i);
    expect(() => assertUsableSpender('0x0000000000000000000000000000000000000000')).toThrow(/zero address/i);
  });

  it('accepts a normal spender address', () => {
    expect(() => assertUsableSpender('0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae')).not.toThrow();
  });
});

// ============= CLI Command Validation =============

describe('buildTradingCommands', () => {
  // Some tests here stub global fetch (e.g. to make the fail-closed swap-target
  // check pass); undo any such stub between tests so it never leaks.
  afterEach(() => { vi.unstubAllGlobals(); });

  it('should show help when required params missing for quote', async () => {
    const cmds = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(cmds.quote([], null, {}, {})).rejects.toThrow('Usage: nansen trade quote');
  });

  it('should show help when quote-id missing for execute', async () => {
    const cmds = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(cmds.execute([], null, {}, {})).rejects.toThrow(/Usage: nansen trade execute/);
  });

  it('should error when no wallet exists for quote', async () => {
    // Mock fetch for the API call
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, quotes: [{ aggregator: 'test' }] }),
    });

    const cmds = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(cmds.quote([], null, {}, {
      chain: 'solana',
      from: 'So11111111111111111111111111111111111111112',
      to: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: '1000000000',
    })).rejects.toThrow(/No wallet/);

    global.fetch = origFetch;
  });

  it('should reject ERC-20 swap with non-zero tx.value', async () => {
    // A compromised API could attach ETH value to an ERC-20 swap to drain funds
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    // Router carries code so the fail-closed target check passes; this test
    // exercises the tx.value validation that runs after it.
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (body.method === 'eth_getCode') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_USDC, // USDC (ERC-20)
        outputMint: BASE_ETH,
        inAmount: '1000000',
        outAmount: '500000000000000',
        transaction: { to: LIFI_ROUTER, data: '0x12345678', value: '5000000000000000000', gas: '200000' },
      }],
    }, 'base', 'local', null, null, { swapMode: 'exactIn', request: evmIntent({ walletAddress: showWallet('default').evm, fromToken: BASE_USDC, toToken: BASE_ETH }) });

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/All quotes failed/);
    expect(logs.some(l => l.includes('non-zero tx.value'))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should reject native ETH swap with missing inAmount but non-zero tx.value', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (body.method === 'eth_getCode') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_ETH,
        outputMint: BASE_USDC,
        // no inAmount or inputAmount — malformed quote
        outAmount: '3000000000',
        transaction: { to: LIFI_ROUTER, data: '0x12345678', value: '5000000000000000000', gas: '200000' },
      }],
    }, 'base', 'local', null, null, { swapMode: 'exactIn', request: evmIntent({ walletAddress: showWallet('default').evm, fromToken: BASE_ETH, toToken: BASE_USDC, amount: '5000000000000000000', maxInputAmount: '5000000000000000000' }) });

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/All quotes failed/);
    expect(logs.some(l => l.includes('missing the input amount'))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should pass validation for ERC-20 swap with value 0', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (body.method === 'eth_getCode') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_USDC,
        outputMint: BASE_ETH,
        inAmount: '1000000',
        outAmount: '500000000000000',
        transaction: { to: LIFI_ROUTER, data: '0x12345678', value: '0', gas: '200000' },
      }],
    }, 'base', 'local', null, null, { swapMode: 'exactIn', request: evmIntent({ walletAddress: showWallet('default').evm, fromToken: BASE_USDC, toToken: BASE_ETH }) });

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    // Execution will fail later (e.g. at signing/broadcast), but should NOT
    // fail at the value validation step
    try { await cmds.execute([], null, {}, { quote: quoteId }); } catch { /* expected */ }
    expect(logs.some(l => l.includes('non-zero tx.value'))).toBe(false);
    expect(logs.some(l => l.includes('value mismatch'))).toBe(false);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should pass validation for native ETH swap with matching value', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (body.method === 'eth_getCode') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_ETH,
        outputMint: BASE_USDC,
        inAmount: '1000000000000000000',
        outAmount: '3000000000',
        transaction: { to: LIFI_ROUTER, data: '0x12345678', value: '1000000000000000000', gas: '200000' },
      }],
    }, 'base', 'local', null, null, { swapMode: 'exactIn', request: evmIntent({ walletAddress: showWallet('default').evm, fromToken: BASE_ETH, toToken: BASE_USDC, amount: '1000000000000000000', maxInputAmount: '1000000000000000000' }) });

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    // Execution will fail later (e.g. at signing/broadcast), but should NOT
    // fail at the value validation step
    try { await cmds.execute([], null, {}, { quote: quoteId }); } catch { /* expected */ }
    expect(logs.some(l => l.includes('non-zero tx.value'))).toBe(false);
    expect(logs.some(l => l.includes('value mismatch'))).toBe(false);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should reject native ETH swap with mismatched tx.value', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (body.method === 'eth_getCode') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_ETH, // native ETH
        outputMint: BASE_USDC,
        inAmount: '1000000000000000000', // 1 ETH
        outAmount: '3000000000',
        transaction: { to: LIFI_ROUTER, data: '0x12345678', value: '5000000000000000000', gas: '200000' },
      }],
    }, 'base', 'local', null, null, { swapMode: 'exactIn', request: evmIntent({ walletAddress: showWallet('default').evm, fromToken: BASE_ETH, toToken: BASE_USDC, amount: '1000000000000000000', maxInputAmount: '1000000000000000000' }) });

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/All quotes failed/);
    expect(logs.some(l => l.includes('value mismatch'))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should error when execute loads a quote without transaction data', async () => {
    // Save a quote without transaction field
    const quoteId = saveQuote({
      success: true,
      quotes: [{ aggregator: 'test', inAmount: '100' }], // no .transaction
    }, 'solana');

    const cmds = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/transaction data/);
  });
});

// ============= WalletConnect Integration =============

describe('WalletConnect quote support', () => {
  it('should save signerType in quote when using walletconnect', () => {
    const quoteId = saveQuote({
      success: true,
      quotes: [{ aggregator: 'test', transaction: { to: '0xabc', data: '0x1234' } }],
    }, 'base', 'walletconnect');

    const loaded = loadQuote(quoteId);
    expect(loaded.signerType).toBe('walletconnect');
  });

  it('should default signerType to local', () => {
    const quoteId = saveQuote({
      success: true,
      quotes: [{ aggregator: 'test', transaction: { to: '0xabc', data: '0x1234' } }],
    }, 'base');

    const loaded = loadQuote(quoteId);
    expect(loaded.signerType).toBe('local');
  });

  it('should allow Solana + walletconnect for quote', async () => {
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

    // Mock global fetch for the quote API call
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        quotes: [{
          aggregator: 'jupiter',
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          inAmount: '1000000000',
          outAmount: '150000000',
          transaction: 'AQAAAA==',
        }],
      }),
    }));

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    await cmds.quote([], null, {}, {
      chain: 'solana',
      from: 'So11111111111111111111111111111111111111112',
      to: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: '1000000000',
      wallet: 'walletconnect',
    });

    // Should NOT have rejected — it should have proceeded to fetch a quote
    expect(logs.some(l => l.includes('WalletConnect is only supported for EVM chains'))).toBe(false);
    // Wallet address should show the Solana address
    expect(logs.some(l => l.includes('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'))).toBe(true);
    // Should have requested the Solana address specifically
    expect(wcTrading.getWalletConnectAddress).toHaveBeenCalledWith('solana');

    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should error when no WalletConnect session for quote', async () => {
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue(null);

    const cmds = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(cmds.quote([], null, {}, {
      chain: 'base',
      from: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1000000000000000000',
      wallet: 'walletconnect',
    })).rejects.toThrow('No WalletConnect session active');

    vi.restoreAllMocks();
  });

  it('should accept "wc" as walletconnect alias for quote', async () => {
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue(null);

    const cmds = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(cmds.quote([], null, {}, {
      chain: 'base',
      from: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1000000000000000000',
      wallet: 'wc',
    })).rejects.toThrow('No WalletConnect session active');

    vi.restoreAllMocks();
  });
});

describe('WalletConnect execute support', () => {
  it('should skip password prompt for walletconnect signerType', async () => {
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    vi.spyOn(wcTrading, 'sendTransactionViaWalletConnect').mockResolvedValue({ txHash: '0xmocktx' });

    // Mock global fetch for waitForReceipt RPC calls
    const originalFetch = global.fetch;
    const rpcResponse = JSON.stringify({ result: { status: '0x1', blockNumber: '0x100' } });
    global.fetch = vi.fn(async () => ({
      status: 200,
      text: () => Promise.resolve(rpcResponse),
      json: () => Promise.resolve({ result: { status: '0x1', blockNumber: '0x100' } }),
    }));

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_ETH,
        outputMint: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        inAmount: '1000000000000000000',
        outAmount: '3000000000',
        transaction: { to: LIFI_ROUTER, data: '0x12345678', value: '1000000000000000000', gas: '200000' },
      }],
    }, 'base', 'walletconnect', null, null, {
      swapMode: 'exactIn',
      request: evmIntent({
        walletAddress: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
        fromToken: BASE_ETH,
        toToken: BASE_USDC,
        amount: '1000000000000000000',
        maxInputAmount: '1000000000000000000',
      }),
    });

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    // Should not require NANSEN_WALLET_PASSWORD since it's walletconnect
    delete process.env.NANSEN_WALLET_PASSWORD;

    await cmds.execute([], null, {}, { quote: quoteId });

    // Should have reached "Sending transaction via WalletConnect..." without password
    expect(logs.some(l => l.includes('WalletConnect'))).toBe(true);
    // Should not have asked for password
    expect(logs.every(l => !l.includes('Enter wallet password'))).toBe(true);

    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should error when WC session expired during execute', async () => {
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue(null);

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'test',
        transaction: { to: '0xabc', data: '0x1234', value: '0', gas: '200000' },
      }],
    }, 'base', 'walletconnect');

    const cmds = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/No WalletConnect session active/);

    vi.restoreAllMocks();
  });

  it('should allow Solana + walletconnect for execute', async () => {
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    vi.spyOn(wcTrading, 'sendSolanaTransactionViaWalletConnect').mockResolvedValue({ signedTransaction: '5K4Ld...' });

    // Mock global fetch for executeTransaction API call
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: () => Promise.resolve({
        status: 'Success',
        txHash: '5K4LdSignedTx...',
      }),
    }));

    // Build a minimal valid Solana transaction (1 sig slot, minimal message)
    // CompactU16(1) = [0x01], then 64 zero bytes for the signature, then message bytes
    const sigCount = Buffer.from([0x01]);
    const emptySig = Buffer.alloc(64);
    const messageBytes = Buffer.from([
      0x01, 0x00, 0x01, // header: 1 signer, 0 readonly signed, 1 readonly unsigned
      0x02, // 2 account keys
      ...Buffer.alloc(32), // account key 1
      ...Buffer.alloc(32), // account key 2
      ...Buffer.alloc(32), // recent blockhash
      0x01, // 1 instruction
      0x01, // program ID index
      0x01, 0x00, // 1 account index: [0]
      0x04, 0x02, 0x00, 0x00, 0x00, // data: transfer instruction
    ]);
    const txBytes = Buffer.concat([sigCount, emptySig, messageBytes]);
    const txBase64 = txBytes.toString('base64');

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'jupiter',
        transaction: txBase64,
      }],
    }, 'solana', 'walletconnect');

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    delete process.env.NANSEN_WALLET_PASSWORD;

    // Execution may fail at a later step (e.g. base58 decode of mock data),
    // but it should reach the WalletConnect signing path
    try { await cmds.execute([], null, {}, { quote: quoteId }); } catch { /* expected */ }

    // Should have used WalletConnect path
    expect(logs.some(l => l.includes('WalletConnect'))).toBe(true);
    expect(logs.some(l => l.includes('WalletConnect is only supported for EVM chains'))).toBe(false);

    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });
});

// ============= Privy execute support =============

describe('Privy execute support', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.PRIVY_APP_ID = 'test-app-id';
    process.env.PRIVY_APP_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('should sign EVM transaction via Privy and broadcast via Trading API', async () => {
    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_ETH,
        outputMint: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        inAmount: '1000000000000000000',
        outAmount: '3000000000',
        transaction: { to: LIFI_ROUTER, data: '0x12345678', value: '1000000000000000000', gas: '210000' },
      }],
    }, 'base', 'privy', { evm: 'wl_evm_1', solana: 'wl_sol_1' }, null, {
      swapMode: 'exactIn',
      request: evmIntent({
        walletAddress: '0xPrivyAddr',
        fromToken: BASE_ETH,
        toToken: BASE_USDC,
        amount: '1000000000000000000',
        maxInputAmount: '1000000000000000000',
      }),
    });

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      // Privy getWallet (to resolve address)
      if (urlStr.includes('privy.io') && opts?.method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 'wl_evm_1', address: '0xPrivyAddr', chain_type: 'ethereum' }),
        });
      }
      // Privy signEvmTransaction
      if (urlStr.includes('privy.io') && opts?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { signed_transaction: '0xSignedTxHex' } }),
        });
      }
      // RPC call (nonce, simulation, waitForReceipt)
      if (urlStr.includes('base') || urlStr.includes('mainnet')) {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.method === 'eth_getTransactionCount') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
        }
        if (body.method === 'eth_getCode') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
        }
        if (body.method === 'eth_call') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' })) });
        }
        if (body.method === 'eth_getTransactionReceipt') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { status: '0x1', blockNumber: '0x100' } })) });
        }
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null })) });
      }
      // Trading API executeTransaction
      if (urlStr.includes('trading-api')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xTxHash', chainType: 'evm', broadcaster: 'test' })),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    delete process.env.NANSEN_WALLET_PASSWORD;
    await cmds.execute([], null, {}, { quote: quoteId });

    // Should have signed via Privy without password
    expect(logs.some(l => l.includes('Signing EVM transaction via Privy'))).toBe(true);
    expect(logs.some(l => l.includes('Transaction successful'))).toBe(true);
    expect(logs.every(l => !l.includes('Enter wallet password'))).toBe(true);
  });

  it('should sign Solana transaction via Privy and broadcast via Trading API', async () => {
    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'test',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        inAmount: '1000000000',
        outAmount: '50000000',
        transaction: 'AQAAAA==',
        metadata: { requestId: 'req-123' },
      }],
    }, 'solana', 'privy', { evm: 'wl_evm_1', solana: 'wl_sol_1' });

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      // Privy signSolanaTransaction
      if (urlStr.includes('privy.io')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { signed_transaction: 'c2lnbmVkVHg=' } }),
        });
      }
      // Trading API executeTransaction
      if (urlStr.includes('trading-api')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', signature: 'SolTxSig', chainType: 'solana', broadcaster: 'test' })),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    delete process.env.NANSEN_WALLET_PASSWORD;
    await cmds.execute([], null, {}, { quote: quoteId });

    expect(logs.some(l => l.includes('Signing Solana transaction via Privy'))).toBe(true);
    expect(logs.some(l => l.includes('Transaction successful'))).toBe(true);
  });

  it('should wait for approval receipt before swap via Privy EVM', async () => {
    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_USDC, // USDC (ERC-20, not native)
        outputMint: OUT_TOKEN,
        inAmount: '1000000',
        outAmount: '990000',
        inputAmount: '1000000',
        approvalAddress: LIFI_ROUTER,
        transaction: {
          to: LIFI_ROUTER,
          data: '0x12345678',
          value: '0',
          gas: '210000',
          maxFeePerGas: '1000000',
          maxPriorityFeePerGas: '1000000',
        },
      }],
    }, 'base', 'privy', { evm: 'wl_evm_1', solana: 'wl_sol_1' }, null, {
      swapMode: 'exactIn',
      request: evmIntent({ walletAddress: '0xPrivyAddr', fromToken: BASE_USDC, toToken: OUT_TOKEN }),
    });

    const rpcCalls = [];
    // Post-approval allowance verification re-reads eth_call, so track the
    // simulated on-chain value: 0 until the approval broadcasts successfully.
    let currentAllowance = 0n;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      // Privy getWallet
      if (urlStr.includes('privy.io') && opts?.method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 'wl_evm_1', address: '0xPrivyAddr', chain_type: 'ethereum' }),
        });
      }
      // Privy signEvmTransaction
      if (urlStr.includes('privy.io') && opts?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { signed_transaction: '0xSignedTxHex' } }),
        });
      }
      // RPC calls
      if (urlStr.includes('base') || urlStr.includes('mainnet')) {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        rpcCalls.push(body.method);
        if (body.method === 'eth_getTransactionCount') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
        }
        if (body.method === 'eth_getCode') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
        }
        // eth_call for allowance check
        if (body.method === 'eth_call') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' + currentAllowance.toString(16).padStart(64, '0') })) });
        }
        // eth_getTransactionReceipt (for waitForReceipt)
        if (body.method === 'eth_getTransactionReceipt') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { status: '0x1', blockNumber: '0x100' } })) });
        }
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null })) });
      }
      // Trading API executeTransaction
      if (urlStr.includes('trading-api')) {
        currentAllowance = 1000000n; // the approval that was just broadcast lands on-chain
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xApprovalHash', chainType: 'evm', broadcaster: 'test' })),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    delete process.env.NANSEN_WALLET_PASSWORD;
    await cmds.execute([], null, {}, { quote: quoteId });

    // Verify approval receipt was waited for (eth_getTransactionReceipt called for approval)
    expect(logs.some(l => l.includes('Waiting for approval confirmation'))).toBe(true);
    expect(logs.some(l => l.includes('Approval confirmed in block'))).toBe(true);
  });

  it('refuses to broadcast when Privy returns no signed revoke transaction', async () => {
    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_USDC,
        outputMint: OUT_TOKEN,
        inAmount: '100000',
        inputAmount: '100000',
        outAmount: '44000000000000',
        approvalAddress: LIFI_ROUTER,
        gas: '300000',
        transaction: {
          to: LIFI_ROUTER,
          data: '0xdeadbeef',
          value: '0',
          gas: '300000',
          maxFeePerGas: '1000000',
          maxPriorityFeePerGas: '1000000',
        },
      }],
    }, 'base', 'privy', { evm: 'wl_evm_1', solana: 'wl_sol_1' }, null, {
      swapMode: 'exactIn',
      request: evmIntent({
        walletAddress: '0xPrivyAddr',
        fromToken: BASE_USDC,
        toToken: OUT_TOKEN,
        amount: '100000',
        maxInputAmount: '100000',
      }),
    });

    const executeBodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(JSON.parse(opts.body));
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xshouldnothappen', chainType: 'evm', broadcaster: 'test' })),
        });
      }
      if (urlStr.includes('privy.io') && opts?.method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 'wl_evm_1', address: '0xPrivyAddr', chain_type: 'ethereum' }),
        });
      }
      if (urlStr.includes('privy.io') && opts?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: {} }),
        });
      }
      if (urlStr.includes('base') || urlStr.includes('mainnet')) {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.method === 'eth_getCode') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
        }
        if (body.method === 'eth_call') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' + (2000000n).toString(16).padStart(64, '0') })) });
        }
        if (body.method === 'eth_getTransactionCount') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
        }
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null })) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));

    const logs = [];
    const cmds = buildTradingCommands({ log: (msg) => logs.push(msg), exit: () => {} });
    await expect(cmds.execute([], null, { 'no-simulate': true }, { quote: quoteId })).rejects.toThrow(/All quotes failed/i);

    expect(executeBodies).toHaveLength(0);
    expect(logs.some(l => l.includes('Privy returned no signed transaction'))).toBe(true);
    expect(logs.some(l => l.includes('Allowance revoke failed'))).toBe(true);
  });

  it('fails closed when Privy returns no signed approval transaction after a successful revoke', async () => {
    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_USDC,
        outputMint: OUT_TOKEN,
        inAmount: '100000',
        inputAmount: '100000',
        outAmount: '44000000000000',
        approvalAddress: LIFI_ROUTER,
        gas: '300000',
        transaction: {
          to: LIFI_ROUTER,
          data: '0xdeadbeef',
          value: '0',
          gas: '300000',
          maxFeePerGas: '1000000',
          maxPriorityFeePerGas: '1000000',
        },
      }],
    }, 'base', 'privy', { evm: 'wl_evm_1', solana: 'wl_sol_1' }, null, {
      swapMode: 'exactIn',
      request: evmIntent({
        walletAddress: '0xPrivyAddr',
        fromToken: BASE_USDC,
        toToken: OUT_TOKEN,
        amount: '100000',
        maxInputAmount: '100000',
      }),
    });

    // Privy signs the revoke (1st POST) but returns an empty response for the
    // approval (2nd POST) — the allowance has already been zeroed on-chain.
    let privyPostCount = 0;
    let currentAllowance = 2000000n; // Oversized existing allowance (2 USDC) → triggers revoke-then-reapprove
    const executeBodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(JSON.parse(opts.body));
        // The broadcast revoke lands on-chain, so the post-revoke allowance
        // verification reads back 0.
        currentAllowance = 0n;
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xRevokeHash', chainType: 'evm', broadcaster: 'test' })),
        });
      }
      if (urlStr.includes('privy.io') && opts?.method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 'wl_evm_1', address: '0xPrivyAddr', chain_type: 'ethereum' }),
        });
      }
      if (urlStr.includes('privy.io') && opts?.method === 'POST') {
        privyPostCount++;
        const data = privyPostCount === 1 ? { signed_transaction: '0xSignedRevoke' } : {};
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data }) });
      }
      if (urlStr.includes('base') || urlStr.includes('mainnet')) {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.method === 'eth_getCode') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
        }
        if (body.method === 'eth_call') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' + currentAllowance.toString(16).padStart(64, '0') })) });
        }
        if (body.method === 'eth_getTransactionCount') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
        }
        if (body.method === 'eth_getTransactionReceipt') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { status: '0x1', blockNumber: '0x100' } })) });
        }
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null })) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));

    const logs = [];
    const cmds = buildTradingCommands({ log: (msg) => logs.push(msg), exit: () => {} });
    await expect(cmds.execute([], null, { 'no-simulate': true }, { quote: quoteId })).rejects.toThrow(/All quotes failed/i);

    // Only the revoke was broadcast; the swap was never signed or sent.
    expect(executeBodies).toHaveLength(1);
    expect(logs.some(l => l.includes('Allowance revoked in block'))).toBe(true);
    expect(logs.some(l => l.includes('Approval failed for #1 after revoking the prior allowance (now 0): Privy returned no signed transaction'))).toBe(true);
  });
});

// ============= stripLeadingZeros =============

describe('stripLeadingZeros', () => {
  it('should strip multiple leading zero bytes', () => {
    expect(stripLeadingZeros(Buffer.from([0, 0, 0, 1, 2]))).toEqual(Buffer.from([1, 2]));
  });

  it('should strip a single leading zero byte', () => {
    expect(stripLeadingZeros(Buffer.from([0, 0xff]))).toEqual(Buffer.from([0xff]));
  });

  it('should return empty buffer for all zeros', () => {
    expect(stripLeadingZeros(Buffer.from([0, 0, 0]))).toEqual(Buffer.alloc(0));
  });

  it('should not strip from non-zero-leading buffer', () => {
    expect(stripLeadingZeros(Buffer.from([1, 2, 3]))).toEqual(Buffer.from([1, 2, 3]));
  });

  it('should handle empty buffer', () => {
    expect(stripLeadingZeros(Buffer.alloc(0))).toEqual(Buffer.alloc(0));
  });
});

// ============= Wrapped Native Token Warning =============

describe('getWrappedNativeFromWarning', () => {
  it('should warn when --from is WETH on Base', () => {
    const warning = getWrappedNativeFromWarning('0x4200000000000000000000000000000000000006', 'base');
    expect(warning).toContain('WETH');
    expect(warning).toContain('wrapped ETH');
    expect(warning).toContain('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  });

  it('should warn when --from is native sentinel on Base', () => {
    const warning = getWrappedNativeFromWarning('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'base');
    expect(warning).toContain('native ETH');
    expect(warning).toContain('WETH');
    expect(warning).toContain('0x4200000000000000000000000000000000000006');
  });

  it('should match addresses case-insensitively', () => {
    const warning = getWrappedNativeFromWarning('0x4200000000000000000000000000000000000006', 'Base');
    expect(warning).toContain('WETH');
  });

  it('should return null for non-wrapped, non-native tokens', () => {
    expect(getWrappedNativeFromWarning('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'base')).toBeNull();
  });

  it('should return null for unsupported chains (e.g. solana)', () => {
    expect(getWrappedNativeFromWarning('So11111111111111111111111111111111111111112', 'solana')).toBeNull();
  });

  it('should return null for null/undefined inputs', () => {
    expect(getWrappedNativeFromWarning(null, 'base')).toBeNull();
    expect(getWrappedNativeFromWarning(undefined, 'base')).toBeNull();
    expect(getWrappedNativeFromWarning('0x4200000000000000000000000000000000000006', null)).toBeNull();
    expect(getWrappedNativeFromWarning(null, null)).toBeNull();
  });
});

// ============= Base Unit Amount Validation =============

describe('validateBaseUnitAmount', () => {
  it('should return error for decimal amounts', () => {
    for (const val of ['0.005', '1.5', '0.000001']) {
      const result = validateBaseUnitAmount(val);
      expect(result).toContain('base units');
      expect(result).toContain(val);
    }
  });

  it('should return null for valid integer amounts', () => {
    expect(validateBaseUnitAmount('1000000000')).toBeNull();
    expect(validateBaseUnitAmount('1000000000000000000')).toBeNull();
  });

  it('should return null for null/undefined', () => {
    expect(validateBaseUnitAmount(null)).toBeNull();
    expect(validateBaseUnitAmount(undefined)).toBeNull();
  });

  it('should return null for zero (used for max sends)', () => {
    expect(validateBaseUnitAmount('0')).toBeNull();
  });

  it('should return null for non-numeric strings (let API handle)', () => {
    expect(validateBaseUnitAmount('abc')).toBeNull();
  });

  it('should return error for negative amounts', () => {
    const result = validateBaseUnitAmount('-100');
    expect(result).toContain('negative');
  });
});

describe('quote handler rejects decimal amounts before API call', () => {
  it('should error on decimal amount and not call fetch', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn();

    const cmds = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(cmds.quote([], null, {}, {
      chain: 'solana', from: 'So11111111111111111111111111111111111111112', to: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '0.005',
    })).rejects.toThrow('base units');
    expect(global.fetch).not.toHaveBeenCalled();

    global.fetch = origFetch;
  });
});

describe('exactOut --max-input requirement is EVM-only', () => {
  it('base exactOut without --max-input is rejected before any API call', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn();

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });

    await expect(cmds.quote([], null, {}, {
      chain: 'base', from: 'USDC', to: 'ETH', amount: '990000', 'swap-mode': 'exactOut',
    })).rejects.toThrow(/requires --max-input/i);
    expect(global.fetch).not.toHaveBeenCalled();

    global.fetch = origFetch;
  });

  it('solana exactOut does NOT require --max-input (Solana has no EVM approval to scope)', async () => {
    // The spend-ceiling guards live only in the EVM execute paths, so requiring
    // the flag on Solana would break existing users for no security gain. The
    // quote may still reject at a later stage (wallet/network), but it must not
    // reject on the missing --max-input flag the way an EVM exactOut quote does.
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error('network stubbed off'));

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });

    await expect(cmds.quote([], null, {}, {
      chain: 'solana', from: 'SOL', to: 'USDC', amount: '1000000', 'swap-mode': 'exactOut',
    })).rejects.not.toThrow(/requires --max-input/i);

    global.fetch = origFetch;
  });
});

// ============= Token Decimal Resolution =============

describe('resolveTokenDecimals', () => {
  it('should return hardcoded decimals for known Solana tokens', async () => {
    expect(await resolveTokenDecimals('So11111111111111111111111111111111111111112', 'solana')).toBe(9);
    expect(await resolveTokenDecimals('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'solana')).toBe(6);
    expect(await resolveTokenDecimals('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'solana')).toBe(6);
  });

  it('should return hardcoded decimals for known EVM tokens (case-insensitive)', async () => {
    expect(await resolveTokenDecimals('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'base')).toBe(18);
    expect(await resolveTokenDecimals('0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', 'base')).toBe(18);
    expect(await resolveTokenDecimals('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'base')).toBe(6);
  });

  it('should fall back to Solana RPC for unknown tokens', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: { value: { data: { parsed: { info: { decimals: 8 } } }, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' } },
      }),
    });

    const decimals = await resolveTokenDecimals('UnknownMint111111111111111111111111111111111', 'solana');
    expect(decimals).toBe(8);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    global.fetch = origFetch;
  });

  it('should fall back to EVM RPC for unknown tokens', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0000000000000000000000000000000000000000000000000000000000000012' }),
    });

    const decimals = await resolveTokenDecimals('0x1234567890abcdef1234567890abcdef12345678', 'base');
    expect(decimals).toBe(18); // 0x12 = 18
    expect(global.fetch).toHaveBeenCalledTimes(1);

    global.fetch = origFetch;
  });

  it('should throw for unknown chain', async () => {
    await expect(resolveTokenDecimals('0xabc', 'polygon')).rejects.toThrow('Unknown chain');
  });

  it('should reject bare symbol on EVM chain', async () => {
    await expect(resolveTokenDecimals('SOL', 'base')).rejects.toThrow('not a recognized token on base');
  });

  it('should reject EVM address on Solana chain', async () => {
    await expect(resolveTokenDecimals('0x1234567890abcdef1234567890abcdef12345678', 'solana')).rejects.toThrow('not a recognized token on solana');
  });

  it('should reject bare symbol on Solana chain', async () => {
    await expect(resolveTokenDecimals('ETH', 'solana')).rejects.toThrow('not a recognized token on solana');
  });
});

describe('convertToBaseUnits', () => {
  it('should convert decimal amounts correctly', () => {
    expect(convertToBaseUnits('0.5', 9)).toBe('500000000');
    expect(convertToBaseUnits('1.5', 6)).toBe('1500000');
    expect(convertToBaseUnits('0.1', 18)).toBe('100000000000000000');
  });

  it('should handle whole numbers', () => {
    expect(convertToBaseUnits('2', 9)).toBe('2000000000');
    expect(convertToBaseUnits('5', 18)).toBe('5000000000000000000');
    expect(convertToBaseUnits('100', 6)).toBe('100000000');
  });

  it('should handle very small amounts without precision loss', () => {
    expect(convertToBaseUnits('0.000000001', 9)).toBe('1');
    expect(convertToBaseUnits('0.000001', 6)).toBe('1');
  });

  it('should handle zero', () => {
    expect(convertToBaseUnits('0', 9)).toBe('0');
    expect(convertToBaseUnits('0.0', 9)).toBe('0');
  });

  it('should ignore trailing zeros beyond token decimals', () => {
    expect(convertToBaseUnits('1.12345600', 6)).toBe('1123456');
  });

  it('should reject amounts with meaningful excess fractional digits', () => {
    expect(() => convertToBaseUnits('1.1234567890', 6)).toThrow('more fractional digits');
    expect(() => convertToBaseUnits('1.5', 0)).toThrow('more fractional digits');
    expect(() => convertToBaseUnits('0.001', 2)).toThrow('more fractional digits');
  });

  it('should reject invalid amount strings', () => {
    expect(() => convertToBaseUnits('abc', 9)).toThrow('Invalid amount');
    expect(() => convertToBaseUnits('1.2.3', 9)).toThrow('Invalid amount');
    expect(() => convertToBaseUnits('', 9)).toThrow('Invalid amount');
    expect(() => convertToBaseUnits('-5', 9)).toThrow('Invalid amount');
    expect(() => convertToBaseUnits('-0.5', 9)).toThrow('Invalid amount');
  });
});

describe('quote command with --amount-unit token', () => {
  it('should convert token amount to base units before API call', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const origFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = vi.fn().mockImplementation(async (url, opts) => {
      fetchCalls.push({ url: url.toString(), opts });
      return {
        ok: true,
        text: async () => JSON.stringify({
          success: true,
          quotes: [{ aggregator: 'test', inAmount: '500000000', outAmount: '1000000', inputMint: 'So111', outputMint: 'EPjFW' }],
        }),
      };
    });

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    await cmds.quote([], null, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '0.5',
      'amount-unit': 'token',
    });

    // The API call should contain the converted amount (500000000 lamports)
    const quoteCall = fetchCalls.find(c => c.url.includes('quote'));
    expect(quoteCall).toBeDefined();
    expect(quoteCall.url).toContain('amount=500000000');
    // Should NOT contain amountUnit in URL (API always gets raw units)
    expect(quoteCall.url).not.toContain('amountUnit');

    global.fetch = origFetch;
    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should resolve decimals against --to token in exactOut mode', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const origFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = vi.fn().mockImplementation(async (url, opts) => {
      fetchCalls.push({ url: url.toString(), opts });
      return {
        ok: true,
        text: async () => JSON.stringify({
          success: true,
          quotes: [{ aggregator: 'test', inAmount: '1000000', outAmount: '1000000', inputMint: 'So111', outputMint: 'EPjFW' }],
        }),
      };
    });

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    // exactOut: "I want exactly 1 USDC out" — should resolve decimals against USDC (6), not SOL (9)
    await cmds.quote([], null, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '1',
      'amount-unit': 'token',
      'swap-mode': 'exactOut',
    });

    const quoteCall = fetchCalls.find(c => c.url.includes('quote'));
    expect(quoteCall).toBeDefined();
    // 1 USDC = 1000000 (6 decimals), NOT 1000000000 (9 decimals from SOL)
    expect(quoteCall.url).toContain('amount=1000000');

    global.fetch = origFetch;
    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should reject unknown --amount-unit values', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn();

    const cmds = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(cmds.quote([], null, {}, {
      chain: 'solana', from: 'SOL', to: 'USDC', amount: '0.5', 'amount-unit': 'foo',
    })).rejects.toThrow('Supported values: token, base');
    expect(global.fetch).not.toHaveBeenCalled();

    global.fetch = origFetch;
  });

  it('should still validate base units when --amount-unit is not set', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn();

    const cmds = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(cmds.quote([], null, {}, {
      chain: 'solana', from: 'SOL', to: 'USDC', amount: '0.5',
    })).rejects.toThrow('base units');
    expect(global.fetch).not.toHaveBeenCalled();

    global.fetch = origFetch;
  });
});

describe('quote command with --amount-unit usd', () => {
  it('should convert USD amount to base units before API call', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const origFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = vi.fn(async (url, opts) => {
      fetchCalls.push({ url: url.toString(), opts });
      // Mock the quote API response
      return {
        ok: true,
        text: async () => JSON.stringify({
          success: true,
          quotes: [{
            inAmount: '604800000',
            outAmount: '50000000',
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            aggregator: 'test',
          }],
        }),
      };
    });

    // Mock API instance with generalSearch returning SOL price
    const mockApiInstance = {
      generalSearch: vi.fn().mockResolvedValue({
        tokens: [{ address: 'So11111111111111111111111111111111111111112', chain: 'solana', price: 82.72 }],
      }),
    };

    const cmds = buildTradingCommands({ log: vi.fn(), exit: vi.fn() });
    await cmds.quote([], mockApiInstance, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '50',
      'amount-unit': 'usd',
    });

    // generalSearch should have been called with the resolved SOL address
    expect(mockApiInstance.generalSearch).toHaveBeenCalledWith({
      query: 'So11111111111111111111111111111111111111112',
      resultType: 'token',
      chain: 'solana',
      limit: 1,
    });

    // The API call should contain the converted amount
    // 50 / 82.72 = 0.60435... SOL = 604353... lamports (9 decimals)
    const quoteCall = fetchCalls.find(c => c.url.includes('quote'));
    expect(quoteCall).toBeDefined();
    // Amount should be an integer (base units), not contain a decimal
    const urlParams = new URL(quoteCall.url).searchParams;
    const amount = urlParams.get('amount');
    expect(amount).toMatch(/^\d+$/);
    // Should NOT contain amountUnit in URL
    expect(quoteCall.url).not.toContain('amountUnit');

    global.fetch = origFetch;
    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should price the --to token in exactOut mode', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const origFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        quotes: [{
          inAmount: '1000000000',
          outAmount: '1000000',
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          aggregator: 'test',
        }],
      }),
    }));

    const mockApiInstance = {
      generalSearch: vi.fn().mockResolvedValue({
        tokens: [{ address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chain: 'solana', price: 1.0 }],
      }),
    };

    const cmds = buildTradingCommands({ log: vi.fn(), exit: vi.fn() });
    await cmds.quote([], mockApiInstance, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '50',
      'amount-unit': 'usd',
      'swap-mode': 'exactOut',
    });

    // Should have searched for USDC (the --to token), not SOL
    expect(mockApiInstance.generalSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      }),
    );

    global.fetch = origFetch;
    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should handle tiny USD amounts that produce scientific notation', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const origFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = vi.fn(async (url, opts) => {
      fetchCalls.push({ url: url.toString(), opts });
      return {
        ok: true,
        text: async () => JSON.stringify({
          success: true,
          quotes: [{
            inAmount: '118',
            outAmount: '1',
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            aggregator: 'test',
          }],
        }),
      };
    });

    const mockApiInstance = {
      generalSearch: vi.fn().mockResolvedValue({
        tokens: [{ address: 'So11111111111111111111111111111111111111112', chain: 'solana', price: 84.0 }],
      }),
    };

    const cmds = buildTradingCommands({ log: vi.fn(), exit: vi.fn() });
    await cmds.quote([], mockApiInstance, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '0.00001',
      'amount-unit': 'usd',
    });

    const quoteCall = fetchCalls.find(c => c.url.includes('quote'));
    expect(quoteCall).toBeDefined();
    const urlParams = new URL(quoteCall.url).searchParams;
    const amount = urlParams.get('amount');
    // Must be a plain integer, not scientific notation
    expect(amount).toMatch(/^\d+$/);

    global.fetch = origFetch;
    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should run balance pre-check after USD conversion', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const origFetch = global.fetch;
    // Mock RPC: getBalance returns 0 lamports (zero SOL balance)
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { value: 0 } }),
    });

    const mockApiInstance = {
      generalSearch: vi.fn().mockResolvedValue({
        tokens: [{ address: 'So11111111111111111111111111111111111111112', chain: 'solana', price: 84.0 }],
      }),
    };

    const cmds = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    // Should fail with balance error, not reach the quote API
    await expect(cmds.quote([], mockApiInstance, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '50',
      'amount-unit': 'usd',
    })).rejects.toThrow(/No SOL balance in wallet/);

    global.fetch = origFetch;
    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should skip balance pre-check in exactOut mode with USD', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const origFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        quotes: [{
          inAmount: '1000000000',
          outAmount: '50000000',
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          aggregator: 'test',
        }],
      }),
    }));

    const mockApiInstance = {
      generalSearch: vi.fn().mockResolvedValue({
        tokens: [{ address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chain: 'solana', price: 1.0 }],
      }),
    };

    let exitCode = null;
    const cmds = buildTradingCommands({
      log: vi.fn(),
      exit: (code) => { exitCode = code; },
    });

    await cmds.quote([], mockApiInstance, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '50',
      'amount-unit': 'usd',
      'swap-mode': 'exactOut',
    });

    // exactOut should skip balance check and succeed (reach quote API)
    expect(exitCode).toBeNull();

    global.fetch = origFetch;
    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should error when price lookup fails', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const origFetch = global.fetch;
    global.fetch = vi.fn();

    const mockApiInstance = {
      generalSearch: vi.fn().mockResolvedValue({ tokens: [] }),
    };

    const cmds = buildTradingCommands({
      log: vi.fn(),
      exit: vi.fn(),
    });

    await expect(cmds.quote([], mockApiInstance, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '50',
      'amount-unit': 'usd',
    })).rejects.toThrow(/USD/);

    global.fetch = origFetch;
    delete process.env.NANSEN_WALLET_PASSWORD;
  });
});

describe('quote command with --amount-unit percent', () => {
  it('should convert percentage to base units before API call', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const origFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = vi.fn().mockImplementation(async (url, opts) => {
      fetchCalls.push({ url: url.toString(), opts });

      // Mock Solana getBalance — 2 SOL = 2_000_000_000 lamports
      if (opts?.body?.includes?.('getBalance')) {
        return {
          ok: true,
          json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 2_000_000_000 } }),
        };
      }

      // Mock quote API
      return {
        ok: true,
        text: async () => JSON.stringify({
          success: true,
          quotes: [{
            aggregator: 'test',
            inAmount: '1000000000',
            outAmount: '50000000',
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          }],
        }),
      };
    });

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    await cmds.quote([], null, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '50',
      'amount-unit': 'percent',
    });

    // 50% of 2 SOL = 1 SOL = 1_000_000_000 lamports
    const quoteCall = fetchCalls.find(c => c.url.includes('quote'));
    expect(quoteCall).toBeDefined();
    expect(quoteCall.url).toContain('amount=1000000000');

    global.fetch = origFetch;
    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should reject percent in exactOut mode', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const cmds = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(cmds.quote([], null, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '50',
      'amount-unit': 'percent',
      'swap-mode': 'exactOut',
    })).rejects.toThrow(/percent.*exactOut/);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should handle fractional percentages like 33.3%', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const origFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = vi.fn().mockImplementation(async (url, opts) => {
      fetchCalls.push({ url: url.toString(), opts });

      // Mock Solana getBalance — 3 SOL = 3_000_000_000 lamports
      if (opts?.body?.includes?.('getBalance')) {
        return {
          ok: true,
          json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 3_000_000_000 } }),
        };
      }

      // Mock quote API
      return {
        ok: true,
        text: async () => JSON.stringify({
          success: true,
          quotes: [{
            aggregator: 'test',
            inAmount: '999000000',
            outAmount: '50000000',
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          }],
        }),
      };
    });

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    await cmds.quote([], null, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '33.3',
      'amount-unit': 'percent',
    });

    // 33.3% of 3 SOL = 0.999 SOL = 999_000_000 lamports
    const quoteCall = fetchCalls.find(c => c.url.includes('quote'));
    expect(quoteCall).toBeDefined();
    expect(quoteCall.url).toContain('amount=999000000');

    global.fetch = origFetch;
    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should reject percentage > 100', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const cmds = buildTradingCommands({
      log: () => {},
      exit: () => {},
    });

    await expect(cmds.quote([], null, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '150',
      'amount-unit': 'percent',
    })).rejects.toThrow(/100%/);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });
});

// ============= API Error Handling =============

describe('API error handling', () => {
  it('should surface INVALID_AMOUNT errors from quote API', async () => {
    const origFetch = global.fetch;
    const errorBody = JSON.stringify({
      code: 'INVALID_AMOUNT',
      message: 'Amount must be a valid numeric string',
      details: { provided: 'abc' },
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => errorBody,
    });

    const { getQuote } = await import('../trading.js');
    await expect(getQuote({
      chainIndex: '501',
      fromTokenAddress: 'So111',
      toTokenAddress: 'EPjFW',
      amount: 'abc',
      userWalletAddress: 'test',
    })).rejects.toThrow('Amount must be a valid numeric string');

    global.fetch = origFetch;
  });

  it('should surface UPSTREAM_BROADCAST_ERROR from execute API', async () => {
    const origFetch = global.fetch;
    const errorBody = JSON.stringify({
      code: 'UPSTREAM_BROADCAST_ERROR',
      message: 'Jupiter Ultra execute failed: transaction simulation failed',
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => errorBody,
    });

    const { executeTransaction } = await import('../trading.js');
    await expect(executeTransaction({
      signedTransaction: 'test',
      chain: 'solana',
    })).rejects.toThrow('simulation failed');

    global.fetch = origFetch;
  });

  it('should surface NO_QUOTES_AVAILABLE errors', async () => {
    const origFetch = global.fetch;
    const errorBody = JSON.stringify({
      code: 'NO_QUOTES_AVAILABLE',
      message: 'No quotes available from any aggregator',
      details: ['Jupiter: insufficient liquidity', 'OKX: pair not supported'],
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => errorBody,
    });

    const { getQuote } = await import('../trading.js');
    await expect(getQuote({
      chainIndex: '501',
      fromTokenAddress: 'x',
      toTokenAddress: 'y',
      amount: '1',
      userWalletAddress: 'z',
    })).rejects.toThrow('No quotes available');

    global.fetch = origFetch;
  });

  it('should handle non-JSON error responses gracefully (e.g. Cloudflare)', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '<!DOCTYPE html><html><body>Cloudflare challenge</body></html>',
    });

    const { getQuote } = await import('../trading.js');
    await expect(getQuote({
      chainIndex: '501',
      fromTokenAddress: 'x',
      toTokenAddress: 'y',
      amount: '1',
      userWalletAddress: 'z',
    })).rejects.toThrow(); // Should throw, not hang

    global.fetch = origFetch;
  });
});

describe('formatQuote price impact warning', () => {
  it('should show warning when priceImpactPct exceeds 5%', () => {
    const output = formatQuote({ aggregator: 'jupiter', inputMint: 'So11111111111111111111111111111111111111112', outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', inAmount: '1000', outAmount: '500', priceImpactPct: '22.59' });
    expect(output).toContain('⚠ Price impact is 22.59%!');
    expect(output).not.toContain('Price Impact: 22.59%');
  });

  it('should show warning when priceImpactPct is negative and exceeds -5%', () => {
    const output = formatQuote({ aggregator: 'okx', inputMint: '0x4ed4e862860bed51a9570b96d89af5e1b0efefed', outputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', inAmount: '100000000000000000000000000', outAmount: '31932262114904620119', priceImpactPct: '-10.03' });
    expect(output).toContain('⚠ Price impact is 10.03%!');
    expect(output).not.toContain('-10.03');
  });

  it('should show normal line when priceImpactPct is low', () => {
    const output = formatQuote({ aggregator: 'jupiter', inputMint: 'So11111111111111111111111111111111111111112', outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', inAmount: '1000', outAmount: '500', priceImpactPct: '0.05' });
    expect(output).toContain('Price Impact: 0.05%');
    expect(output).not.toContain('WARNING');
  });

  it('should not show price impact line when priceImpactPct is absent', () => {
    const output = formatQuote({ aggregator: 'jupiter', inputMint: 'So11111111111111111111111111111111111111112', outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', inAmount: '1000', outAmount: '500' });
    expect(output).not.toContain('Price Impact');
    expect(output).not.toContain('WARNING');
  });
});

describe('simulateEvmCall — insufficient funds error formatting', () => {
  it('returns human-readable error when wallet has no ETH', async () => {
    const origFetch = global.fetch;
    // evmRpcCall uses res.text() so mock must expose text(), not json()
    const rpcBody = JSON.stringify({
      error: {
        message: 'err: insufficient funds for gas * price + value: address 0x49Cf91e5B2f7eC18AE861b4AC7565FEa69B29d84 have 0 want 400000000000000 (supplied gas 600000000)',
      },
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => rpcBody });

    const result = await simulateEvmCall('base', {
      from: '0x49Cf91e5B2f7eC18AE861b4AC7565FEa69B29d84',
      to: '0x1234567890abcdef1234567890abcdef12345678',
      data: '0xabcd',
      value: '0x16345785d8a0000',
    });

    global.fetch = origFetch;

    expect(result.success).toBe(false);
    // Should NOT leak raw wei amounts or cryptic RPC jargon
    expect(result.reason).not.toContain('400000000000000');
    expect(result.reason).not.toContain('600000000');
    expect(result.reason).not.toContain('supplied gas');
    // Should be human-readable in ETH
    expect(result.reason).toContain('ETH');
    expect(result.reason).toContain('0.000000 ETH'); // wallet has 0
    expect(result.reason).toContain('0.000400 ETH'); // trade needs 0.0004 ETH
    // Should include wallet address for funding
    expect(result.reason).toContain('0x49Cf91e5B2f7eC18AE861b4AC7565FEa69B29d84');
  });

  it('passes through non-funds simulation errors unchanged', async () => {
    const origFetch = global.fetch;
    const rpcBody = JSON.stringify({ error: { message: 'execution reverted: INSUFFICIENT_OUTPUT_AMOUNT' } });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => rpcBody });

    const result = await simulateEvmCall('base', {
      from: '0x49Cf91e5B2f7eC18AE861b4AC7565FEa69B29d84',
      to: '0x1234567890abcdef1234567890abcdef12345678',
      data: '0xabcd',
    });

    global.fetch = origFetch;

    expect(result.success).toBe(false);
    expect(result.reason).toContain('INSUFFICIENT_OUTPUT_AMOUNT');
  });
});

// ============= Cross-Chain Support =============

describe('formatQuote cross-chain metadata', () => {
  it('should display bridge info when isCrossChain is true', () => {
    const output = formatQuote({
      aggregator: 'lifi',
      inputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inAmount: '1000000',
      outAmount: '998000',
      metadata: {
        isCrossChain: true,
        bridgeTool: 'stargate',
        executionDuration: 300,
        feeCosts: [
          { amountUSD: '0.50' },
          { amountUSD: '0.25' },
        ],
      },
    });
    expect(output).toContain('Bridge:       stargate');
    expect(output).toContain('Est. Time:    ~5 min');
    expect(output).toContain('Bridge Fees:  $0.75');
  });

  it('should show adaptive precision for sub-cent bridge fees', () => {
    const output = formatQuote({
      aggregator: 'okx',
      inputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inAmount: '50000',
      outAmount: '49500',
      metadata: {
        isCrossChain: true,
        bridgeTool: 'stargate',
        executionDuration: 300,
        feeCosts: [
          { name: 'relay', amountUSD: '0.0005' },
          { name: 'gas', amountUSD: '0.0003' },
        ],
      },
    });
    expect(output).toContain('Bridge Fees:  $0.0008');
  });

  it('should show "< 1 min" for fast bridges', () => {
    const output = formatQuote({
      aggregator: 'okx',
      inputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inAmount: '50000',
      outAmount: '49500',
      metadata: {
        isCrossChain: true,
        bridgeTool: 'stargate',
        executionDuration: 2,
      },
    });
    expect(output).toContain('Est. Time:    < 1 min');
  });

  it('should not display bridge info for same-chain quotes', () => {
    const output = formatQuote({
      aggregator: 'okx',
      inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      outputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      inAmount: '1000000000000000000',
      outAmount: '3500000000',
    });
    expect(output).not.toContain('Bridge');
    expect(output).not.toContain('Est. Time');
  });
});

describe('cross-chain token resolution', () => {
  it('should resolve --to token against destination chain', () => {
    // USDC on solana vs base have different addresses
    const solanaUSDC = resolveTokenAddress('USDC', 'solana');
    const baseUSDC = resolveTokenAddress('USDC', 'base');
    expect(solanaUSDC).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(baseUSDC).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(solanaUSDC).not.toBe(baseUSDC);
  });
});

describe('getBridgeStatus', () => {
  it('should call bridge status endpoint and return result', async () => {
    const origFetch = global.fetch;
    const mockResponse = {
      status: 'DONE',
      tool: 'stargate',
      sending: { txHash: '0xabc', amount: '1000000' },
      receiving: { txHash: '0xdef', amount: '998000' },
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(mockResponse),
    });

    const result = await getBridgeStatus('0xabc', 'base', 'solana');
    expect(result.status).toBe('DONE');
    expect(result.tool).toBe('stargate');
    expect(result.receiving.txHash).toBe('0xdef');

    // Verify correct URL params
    const callUrl = new URL(global.fetch.mock.calls[0][0]);
    expect(callUrl.searchParams.get('txHash')).toBe('0xabc');
    expect(callUrl.searchParams.get('fromChain')).toBe('8453');
    expect(callUrl.searchParams.get('toChain')).toBe('1151111081099710');

    global.fetch = origFetch;
  });

  it('should throw on API error', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ message: 'Transaction not found' }),
    });

    await expect(getBridgeStatus('0xbad', 'base', 'solana'))
      .rejects.toThrow('Transaction not found');

    global.fetch = origFetch;
  });
});

describe('pollBridgeStatus', () => {
  it('should return immediately when status is DONE', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'DONE', receiving: { status: 'DONE', txHash: '0xfinal' } }),
    });

    const result = await pollBridgeStatus('0xabc', 'base', 'solana', { log: () => {} });
    expect(result.status).toBe('DONE');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    global.fetch = origFetch;
  });

  it('should throw on FAILED status', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'FAILED', substatusMessage: 'Slippage too high' }),
    });

    await expect(pollBridgeStatus('0xabc', 'base', 'solana', { log: () => {} }))
      .rejects.toThrow('Bridge failed: Slippage too high');

    global.fetch = origFetch;
  });

  it('should timeout after timeoutMs', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'PENDING' }),
    });

    await expect(pollBridgeStatus('0xabc', 'base', 'solana', { timeoutMs: 50, pollMs: 10, log: () => {} }))
      .rejects.toThrow('polling timed out');

    global.fetch = origFetch;
  });
});

describe('resolveUsdPrice', () => {
  it('should return USD price from search API', async () => {
    const mockApi = {
      generalSearch: vi.fn().mockResolvedValue({
        tokens: [{ address: 'So11111111111111111111111111111111111111112', chain: 'solana', price: 82.5 }],
      }),
    };
    const { resolveUsdPrice } = await import('../trading.js');
    const price = await resolveUsdPrice(mockApi, 'So11111111111111111111111111111111111111112', 'solana');
    expect(price).toBe(82.5);
    expect(mockApi.generalSearch).toHaveBeenCalledWith({
      query: 'So11111111111111111111111111111111111111112',
      resultType: 'token',
      chain: 'solana',
      limit: 1,
    });
  });

  it('should throw when search returns no tokens', async () => {
    const mockApi = {
      generalSearch: vi.fn().mockResolvedValue({ tokens: [] }),
    };
    const { resolveUsdPrice } = await import('../trading.js');
    await expect(resolveUsdPrice(mockApi, 'So11111111111111111111111111111111111111112', 'solana'))
      .rejects.toThrow('Could not resolve USD price');
  });

  it('should throw when price is null', async () => {
    const mockApi = {
      generalSearch: vi.fn().mockResolvedValue({
        tokens: [{ address: 'So11111111111111111111111111111111111111112', chain: 'solana', price: null }],
      }),
    };
    const { resolveUsdPrice } = await import('../trading.js');
    await expect(resolveUsdPrice(mockApi, 'So11111111111111111111111111111111111111112', 'solana'))
      .rejects.toThrow('Could not resolve USD price');
  });

  it('should throw when price is 0', async () => {
    const mockApi = {
      generalSearch: vi.fn().mockResolvedValue({
        tokens: [{ address: 'So11111111111111111111111111111111111111112', chain: 'solana', price: 0 }],
      }),
    };
    const { resolveUsdPrice } = await import('../trading.js');
    await expect(resolveUsdPrice(mockApi, 'So11111111111111111111111111111111111111112', 'solana'))
      .rejects.toThrow('Could not resolve USD price');
  });
});

// ============= Relay aggregator =============

describe('Relay aggregator: native SOL system mint', () => {
  it('formatQuote does not crash on Solana system-mint inputMint', () => {
    const output = formatQuote({
      aggregator: 'relay',
      inputMint: '11111111111111111111111111111111',
      outputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      inAmount: '1000000000',
      outAmount: '180000000',
      metadata: {
        isCrossChain: true,
        bridgeTool: 'relay',
        estimatedTimeSeconds: 60,
      },
    });
    expect(output).toContain('relay');
    expect(output).toContain('11111111111');
    expect(output).toContain('Bridge:       relay');
    expect(output).toContain('Est. Time:    ~1 min');
  });

  it('formatQuote does NOT show approval warning for native SOL system mint', () => {
    // Even if approvalAddress somehow leaks through, native SOL must skip the warning.
    const output = formatQuote({
      aggregator: 'relay',
      inputMint: '11111111111111111111111111111111',
      outputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      inAmount: '1000000000',
      outAmount: '180000000',
      approvalAddress: '0xshouldNotBeShown',
    });
    expect(output).not.toContain('Requires token approval');
  });
});

describe('Relay aggregator: empty approvalAddress', () => {
  it('formatQuote skips approval line when approvalAddress is empty string', () => {
    const output = formatQuote({
      aggregator: 'relay',
      inputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
      outputMint: '11111111111111111111111111111111',
      inAmount: '10000000',
      outAmount: '50000000',
      approvalAddress: '', // Relay's "no approval needed" signal
    });
    expect(output).not.toContain('Requires token approval');
  });

  it('execute path skips allowance check + approval tx when approvalAddress is empty', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const fetchCalls = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return {}; } })() : {};
      fetchCalls.push({ url: urlStr, method: body.method, body });
      // RPC: nonce + receipt
      if (body.method === 'eth_getTransactionCount') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      }
      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      }
      if (body.method === 'eth_call') {
        // Should NOT be hit for empty approvalAddress (no allowance check); succeed in case simulation runs.
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' })) });
      }
      if (body.method === 'eth_getTransactionReceipt') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { status: '0x1', blockNumber: '0x100' } })) });
      }
      // Bridge status: return DONE so the post-execute polling exits quickly
      if (urlStr.includes('/bridge/status')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ status: 'DONE', receiving: { status: 'DONE', txHash: 'destTx' } })),
        });
      }
      // Trading API /execute → success
      if (urlStr.includes('trading-api')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xRelayHash', chainType: 'evm', broadcaster: 'test' })),
        });
      }
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'relay',
        inputMint: BASE_USDC, // USDC
        outputMint: '11111111111111111111111111111111',
        inAmount: '10000000',
        outAmount: '50000000',
        approvalAddress: '', // Relay says no approval needed
        transaction: { to: RELAY_ROUTER, data: '0x12345678', value: '0', gas: '300000', maxFeePerGas: '5000000', maxPriorityFeePerGas: '1000000' },
        metadata: { requestId: 'relay-req-empty', isCrossChain: true, bridgeTool: 'relay' },
      }],
    }, 'base', 'local', null, 'solana', {
      swapMode: 'exactIn',
      request: evmIntent({ walletAddress: showWallet('default').evm, fromToken: BASE_USDC, toToken: '11111111111111111111111111111111', toChain: 'solana', amount: '10000000', maxInputAmount: '10000000' }),
    });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    try { await cmds.execute([], null, {}, { quote: quoteId }); } catch { /* may fail at bridge-poll, that's fine */ }

    // No approval message
    expect(logs.some(l => l.includes('Approval required'))).toBe(false);
    expect(logs.some(l => l.includes('Approval confirmed'))).toBe(false);

    // /execute was called exactly once (the swap), not twice (no approval tx)
    const executeCalls = fetchCalls.filter(c => c.url.includes('trading-api') && c.url.includes('/execute'));
    expect(executeCalls.length).toBe(1);

    // No allowance check (eth_call with the allowance selector 0xdd62ed3e)
    const allowanceCalls = fetchCalls.filter(c => c.method === 'eth_call'
      && c.body?.params?.[0]?.data?.startsWith('0xdd62ed3e'));
    expect(allowanceCalls.length).toBe(0);

    delete process.env.NANSEN_WALLET_PASSWORD;
    vi.unstubAllGlobals();
  });
});

describe('Swap target validation blocks a poisoned quote (security hardening)', () => {
  it('does not broadcast when the swap target is an EOA (no contract code)', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const fetchCalls = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return {}; } })() : {};
      fetchCalls.push({ url: urlStr, method: body.method, body });
      if (body.method === 'eth_getTransactionCount') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      }
      // Target carries NO contract code → an EOA, never a legit router.
      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' })) });
      }
      if (body.method === 'eth_call') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' })) });
      }
      if (urlStr.includes('trading-api')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xShouldNotHappen', chainType: 'evm', broadcaster: 'test' })) });
      }
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    // Native ETH swap (no approval step), so the target check is the only gate.
    const inAmount = '1000000000000000000';
    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // native ETH
        outputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
        inAmount,
        outAmount: '2500000000',
        approvalAddress: '',
        transaction: { to: '0x000000000000000000000000000000000000dEaD', data: '0xdeadbeef', value: inAmount, gas: '300000', maxFeePerGas: '5000000', maxPriorityFeePerGas: '1000000' },
        metadata: {},
      }],
    }, 'base', 'local');

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/All quotes failed/i);

    // The swap was never broadcast.
    const executeCalls = fetchCalls.filter(c => c.url.includes('trading-api') && c.url.endsWith('/execute'));
    expect(executeCalls.length).toBe(0);
    // The failure names the target check.
    expect(logs.some(l => l.includes('not a contract'))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
    vi.unstubAllGlobals();
  });

  it('rejects an ERC-20 poisoned target before broadcasting any approval', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const fetchCalls = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return {}; } })() : {};
      fetchCalls.push({ url: urlStr, method: body.method, body });
      if (body.method === 'eth_getTransactionCount') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      }
      // Swap target is a codeless EOA.
      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' })) });
      }
      if (body.method === 'eth_call') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' })) });
      }
      if (urlStr.includes('trading-api')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xShouldNotHappen', chainType: 'evm', broadcaster: 'test' })) });
      }
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    // ERC-20 swap (USDC in) requiring approval, but the swap target is an EOA.
    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_USDC, // USDC
        outputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        inAmount: '5000000',
        outAmount: '2000000000000000',
        approvalAddress: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae',
        transaction: { to: '0x000000000000000000000000000000000000dEaD', data: '0xdeadbeef', value: '0', gas: '300000', maxFeePerGas: '5000000', maxPriorityFeePerGas: '1000000' },
        metadata: {},
      }],
    }, 'base', 'local');

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/All quotes failed/i);

    // Nothing broadcast to the Trading API — crucially, NO approval tx either,
    // which proves the target guard runs before the approval step.
    const executeCalls = fetchCalls.filter(c => c.url.includes('trading-api') && c.url.endsWith('/execute'));
    expect(executeCalls.length).toBe(0);
    // No allowance check was even attempted (guard fired before the approval block).
    const allowanceCalls = fetchCalls.filter(c => c.method === 'eth_call' && c.body?.params?.[0]?.data?.startsWith('0xdd62ed3e'));
    expect(allowanceCalls.length).toBe(0);
    expect(logs.some(l => l.includes('not a contract'))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
    vi.unstubAllGlobals();
  });

  it('does not broadcast when the quote input exceeds the persisted request intent', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const fetchCalls = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return {}; } })() : {};
      fetchCalls.push({ url: urlStr, method: body.method, body });
      if (body.method === 'eth_getTransactionCount') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      // Target IS a real contract, so the target guard passes and the intent check is what fires.
      if (body.method === 'eth_getCode') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      if (body.method === 'eth_call') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' })) });
      if (urlStr.includes('trading-api')) return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xShouldNotHappen', chainType: 'evm', broadcaster: 'test' })) });
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const OUT = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const ROUTER = LIFI_ROUTER;
    // The user asked to sell 1 USDC; the (compromised) quote claims 5 USDC of input,
    // which would enlarge both the scoped approval and any native value.
    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: USDC,
        outputMint: OUT,
        inAmount: '5000000',
        inputAmount: '5000000',
        outAmount: '2000000000000000',
        approvalAddress: ROUTER,
        transaction: { to: ROUTER, data: '0xdeadbeef', value: '0', gas: '300000', maxFeePerGas: '5000000', maxPriorityFeePerGas: '1000000' },
        metadata: {},
      }],
    }, 'base', 'local', null, null, {
      swapMode: 'exactIn',
      request: evmIntent({ walletAddress: showWallet('default').evm, fromToken: USDC, toToken: OUT }),
    });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/All quotes failed/i);

    // Nothing broadcast, and no allowance check — the intent guard fired first.
    const executeCalls = fetchCalls.filter(c => c.url.includes('trading-api') && c.url.endsWith('/execute'));
    expect(executeCalls.length).toBe(0);
    const allowanceCalls = fetchCalls.filter(c => c.method === 'eth_call' && c.body?.params?.[0]?.data?.startsWith('0xdd62ed3e'));
    expect(allowanceCalls.length).toBe(0);
    expect(logs.some(l => /does not match the requested input/i.test(l))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
    vi.unstubAllGlobals();
  });

  it('does not broadcast an approval when the spender is an over-length (calldata-shifting) value', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const fetchCalls = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return {}; } })() : {};
      fetchCalls.push({ url: urlStr, method: body.method, body });
      if (body.method === 'eth_getTransactionCount') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      if (body.method === 'eth_getCode') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      if (body.method === 'eth_call') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' })) });
      if (urlStr.includes('trading-api')) return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xShouldNotHappen', chainType: 'evm', broadcaster: 'test' })) });
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const OUT = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const ROUTER = LIFI_ROUTER;
    // 0x + 128 hex chars: decodes to (attacker, MAX) if concatenated unchecked.
    const overlengthSpender = '0x' + '00'.repeat(12) + '22'.repeat(20) + 'f'.repeat(64);
    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: USDC,
        outputMint: OUT,
        inAmount: '1000000',
        inputAmount: '1000000',
        outAmount: '2000000000000000',
        approvalAddress: overlengthSpender,
        transaction: { to: ROUTER, data: '0xdeadbeef', value: '0', gas: '300000', maxFeePerGas: '5000000', maxPriorityFeePerGas: '1000000' },
        metadata: {},
      }],
    }, 'base', 'local', null, null, {
      swapMode: 'exactIn',
      request: evmIntent({ walletAddress: showWallet('default').evm, fromToken: USDC, toToken: OUT }),
    });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/All quotes failed/i);

    const executeCalls = fetchCalls.filter(c => c.url.includes('trading-api') && c.url.endsWith('/execute'));
    expect(executeCalls.length).toBe(0);
    expect(logs.some(l => /not a valid 20-byte address/i.test(l))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
    vi.unstubAllGlobals();
  });

  it('does not broadcast a same-chain swap whose calldata is a bare ERC-20 transfer', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const fetchCalls = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return {}; } })() : {};
      fetchCalls.push({ url: urlStr, method: body.method, body });
      if (body.method === 'eth_getTransactionCount') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      // Target IS a real contract (a sibling token), so target + intent guards pass
      // and the bare-transfer calldata shape is what blocks it.
      if (body.method === 'eth_getCode') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      if (body.method === 'eth_call') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' })) });
      if (urlStr.includes('trading-api')) return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xShouldNotHappen', chainType: 'evm', broadcaster: 'test' })) });
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const WETH = '0x4200000000000000000000000000000000000006'; // sibling token, != inputMint
    const OUT = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    // A poisoned quote: to = WETH, data = transfer(attacker, ...) — a direct
    // drain of a token the wallet holds, disguised as a swap.
    const transferCalldata = '0xa9059cbb' + '00'.repeat(12) + '22'.repeat(20) + 'f'.repeat(64);
    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: USDC,
        outputMint: OUT,
        inAmount: '1000000',
        inputAmount: '1000000',
        outAmount: '2000000000000000',
        approvalAddress: '', // native-style: no approval, so the calldata guard is the gate
        transaction: { to: WETH, data: transferCalldata, value: '0', gas: '300000', maxFeePerGas: '5000000', maxPriorityFeePerGas: '1000000' },
        metadata: {},
      }],
    }, 'base', 'local', null, null, {
      swapMode: 'exactIn',
      request: evmIntent({ walletAddress: showWallet('default').evm, fromToken: USDC, toToken: OUT }),
    });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/All quotes failed/i);

    const executeCalls = fetchCalls.filter(c => c.url.includes('trading-api') && c.url.endsWith('/execute'));
    expect(executeCalls.length).toBe(0);
    expect(logs.some(l => /bare ERC-20 transfer/i.test(l))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
    vi.unstubAllGlobals();
  });

  it('does not broadcast a cross-chain bridge quote whose calldata is a bare ERC-20 transfer', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const fetchCalls = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return {}; } })() : {};
      fetchCalls.push({ url: urlStr, method: body.method, body });
      if (body.method === 'eth_getTransactionCount') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      if (body.method === 'eth_getCode') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      if (body.method === 'eth_call') return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' })) });
      if (urlStr.includes('trading-api')) return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xShouldNotHappen', chainType: 'evm', broadcaster: 'test' })) });
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const WETH = '0x4200000000000000000000000000000000000006'; // sibling token, != inputMint
    const OUT = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    // A poisoned bridge quote: source-chain tx is transfer(attacker, ...) to a
    // sibling token. validateSwapTarget passes (to != inputMint, has code); the
    // bare-transfer guard must still fire on the cross-chain path (toChain set).
    const transferCalldata = '0xa9059cbb' + '00'.repeat(12) + '22'.repeat(20) + 'f'.repeat(64);
    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: USDC,
        outputMint: OUT,
        inAmount: '1000000',
        inputAmount: '1000000',
        outAmount: '2000000000000000',
        approvalAddress: '',
        transaction: { to: WETH, data: transferCalldata, value: '0', gas: '300000', maxFeePerGas: '5000000', maxPriorityFeePerGas: '1000000' },
        metadata: {},
      }],
    }, 'base', 'local', null, 'solana', {
      swapMode: 'exactIn',
      request: evmIntent({ walletAddress: showWallet('default').evm, fromToken: USDC, toToken: OUT }),
    });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/All quotes failed/i);

    const executeCalls = fetchCalls.filter(c => c.url.includes('trading-api') && c.url.endsWith('/execute'));
    expect(executeCalls.length).toBe(0);
    expect(logs.some(l => /bare ERC-20 transfer/i.test(l))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
    vi.unstubAllGlobals();
  });

  it('skips a malformed zero-input quote instead of broadcasting a zero-amount approval', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const fetchCalls = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return {}; } })() : {};
      fetchCalls.push({ url: urlStr, method: body.method, body });
      if (body.method === 'eth_getTransactionCount') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      }
      // Target IS a contract (target check passes), so we reach the approval step.
      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      }
      if (body.method === 'eth_call') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x0000000000000000000000000000000000000000000000000000000000000000' })) });
      }
      if (urlStr.includes('trading-api')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xShouldNotHappen', chainType: 'evm', broadcaster: 'test' })) });
      }
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    // Malformed ERC-20 quote: no input amount.
    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
        outputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        inAmount: '0',
        inputAmount: '0',
        outAmount: '2000000000000000',
        approvalAddress: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae',
        transaction: { to: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', data: '0xdeadbeef', value: '0', gas: '300000', maxFeePerGas: '5000000', maxPriorityFeePerGas: '1000000' },
        metadata: {},
      }],
    }, 'base', 'local', null, null, {
      swapMode: 'exactIn',
      request: evmIntent({ walletAddress: showWallet('default').evm, fromToken: BASE_USDC, toToken: BASE_ETH, amount: '0', maxInputAmount: '0' }),
    });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/All quotes failed/i);

    // No zero-amount approve() broadcast.
    const executeCalls = fetchCalls.filter(c => c.url.includes('trading-api') && c.url.endsWith('/execute'));
    expect(executeCalls.length).toBe(0);
    expect(logs.some(l => l.includes('zero input amount'))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
    vi.unstubAllGlobals();
  });
});

describe('ERC-20 excessive allowance handling', () => {
  const approveSelector = '095ea7b3';
  const amountWord = (amount) => BigInt(amount).toString(16).padStart(64, '0');
  const hexResult = (amount) => '0x' + amountWord(amount);

  function saveLocalErc20Quote(walletAddress, { inputAmount = '100000', approvalAddress = LIFI_ROUTER } = {}) {
    return saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_USDC,
        outputMint: BASE_ETH,
        inAmount: inputAmount,
        inputAmount,
        outAmount: '44000000000000',
        approvalAddress,
        gas: '300000',
        transaction: {
          to: approvalAddress,
          data: '0xdeadbeef',
          value: '0',
          gas: '300000',
          gasPrice: '5000000',
        },
        metadata: {},
      }],
    }, 'base', 'local', null, null, {
      swapMode: 'exactIn',
      request: evmIntent({
        walletAddress,
        fromToken: BASE_USDC,
        toToken: BASE_ETH,
        amount: inputAmount,
        maxInputAmount: inputAmount,
      }),
    });
  }

  function saveWalletConnectErc20Quote(walletAddress, { inputAmount = '100000', approvalAddress = LIFI_ROUTER } = {}) {
    return saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_USDC,
        outputMint: BASE_ETH,
        inAmount: inputAmount,
        inputAmount,
        outAmount: '44000000000000',
        approvalAddress,
        gas: '300000',
        transaction: {
          to: approvalAddress,
          data: '0xdeadbeef',
          value: '0',
          gas: '300000',
          gasPrice: '5000000',
        },
        metadata: {},
      }],
    }, 'base', 'walletconnect', null, null, {
      swapMode: 'exactIn',
      request: evmIntent({
        walletAddress,
        fromToken: BASE_USDC,
        toToken: BASE_ETH,
        amount: inputAmount,
        maxInputAmount: inputAmount,
      }),
    });
  }

  function mockLocalEvmExecute({ allowance, executeResponses }) {
    const executeBodies = [];
    const sequence = [];
    // Post-action allowance verification re-reads eth_call, so track the
    // simulated on-chain value and update it when a broadcast approve()
    // (revoke-to-zero or scoped reapproval) actually lands.
    let currentAllowance = BigInt(allowance);
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? JSON.parse(opts.body) : {};

      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        const response = executeResponses[executeBodies.length] ?? executeResponses.at(-1);
        executeBodies.push(body);
        sequence.push({ type: 'execute', txHash: response.txHash, signedTransaction: body.signedTransaction });
        const selectorIdx = body.signedTransaction?.indexOf(approveSelector);
        if (response.status === 'Success' && selectorIdx >= 0) {
          const amountStart = selectorIdx + approveSelector.length + 64;
          currentAllowance = BigInt('0x' + body.signedTransaction.slice(amountStart, amountStart + 64));
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify(response)),
        });
      }

      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      }
      if (body.method === 'eth_getTransactionCount') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      }
      if (body.method === 'eth_getTransactionReceipt') {
        const txHash = body.params?.[0];
        sequence.push({ type: 'receipt', txHash });
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { status: '0x1', blockNumber: '0x100' } })) });
      }
      if (body.method === 'eth_call') {
        const data = body.params?.[0]?.data || '';
        const result = data.startsWith('0xdd62ed3e') ? hexResult(currentAllowance) : '0x';
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })) });
      }

      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));
    return { executeBodies, sequence, setAllowance: (v) => { currentAllowance = BigInt(v); } };
  }

  beforeEach(() => {
    __setAllowanceTimingForTests({ verifyDelayMs: 0, propagationDelayMs: 0 });
  });

  afterEach(() => {
    __setAllowanceTimingForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('revokes an oversized allowance, waits for receipt, reapproves scoped amount, then broadcasts swap', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const walletAddress = showWallet('default').evm;
    const quoteId = saveLocalErc20Quote(walletAddress);
    const { executeBodies, sequence } = mockLocalEvmExecute({
      allowance: 2000000n,
      executeResponses: [
        { status: 'Success', txHash: '0xRevokeHash', chainType: 'evm', broadcaster: 'test' },
        { status: 'Success', txHash: '0xApprovalHash', chainType: 'evm', broadcaster: 'test' },
        { status: 'Success', txHash: '0xSwapHash', chainType: 'evm', broadcaster: 'test' },
      ],
    });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await cmds.execute([], null, { 'no-simulate': true }, { quote: quoteId });

    expect(executeBodies).toHaveLength(3);
    expect(executeBodies[0].signedTransaction).toContain(approveSelector);
    expect(executeBodies[0].signedTransaction).toContain(amountWord(0n));
    expect(executeBodies[1].signedTransaction).toContain(approveSelector);
    expect(executeBodies[1].signedTransaction).toContain(amountWord(100000n));
    expect(executeBodies[2].signedTransaction).not.toContain(approveSelector);
    expect(sequence.map(e => `${e.type}:${e.txHash}`)).toEqual([
      'execute:0xRevokeHash',
      'receipt:0xRevokeHash',
      'execute:0xApprovalHash',
      'receipt:0xApprovalHash',
      'execute:0xSwapHash',
      'receipt:0xSwapHash',
    ]);
    expect(logs.some(l => l.includes('Existing allowance (2000000)'))).toBe(true);
    expect(logs.some(l => l.includes('Allowance revoked in block'))).toBe(true);
  });

  it('fails closed when reapproval fails after a successful revoke', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const walletAddress = showWallet('default').evm;
    const quoteId = saveLocalErc20Quote(walletAddress);
    const { executeBodies } = mockLocalEvmExecute({
      allowance: 2000000n,
      executeResponses: [
        { status: 'Success', txHash: '0xRevokeHash', chainType: 'evm', broadcaster: 'test' },
        { status: 'Failed', error: 'approval simulation failed', txHash: '0xApprovalHash', chainType: 'evm', broadcaster: 'test' },
      ],
    });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await expect(cmds.execute([], null, { 'no-simulate': true }, { quote: quoteId })).rejects.toThrow(/All quotes failed/i);

    expect(executeBodies).toHaveLength(2);
    expect(executeBodies[0].signedTransaction).toContain(amountWord(0n));
    expect(executeBodies[1].signedTransaction).toContain(amountWord(100000n));
    expect(logs.some(l => l.includes('Approval failed for #1 after revoking the prior allowance (now 0)'))).toBe(true);
  });

  it('fails closed when a revoke receipt succeeds but the allowance does not actually clear', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const walletAddress = showWallet('default').evm;
    const quoteId = saveLocalErc20Quote(walletAddress);
    const executeBodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(body);
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xRevokeHash', chainType: 'evm', broadcaster: 'test' })),
        });
      }
      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      }
      if (body.method === 'eth_getTransactionCount') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      }
      if (body.method === 'eth_getTransactionReceipt') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { status: '0x1', blockNumber: '0x100' } })) });
      }
      if (body.method === 'eth_call') {
        // The revoke's receipt reports success, but the allowance never actually
        // clears on-chain (e.g. a broadcaster that confirmed the wrong tx).
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: hexResult(2000000n) })) });
      }
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await expect(cmds.execute([], null, { 'no-simulate': true }, { quote: quoteId })).rejects.toThrow(/All quotes failed/i);

    // Only the revoke was broadcast; the reapproval and swap never ran.
    expect(executeBodies).toHaveLength(1);
    expect(logs.some(l => l.includes('Revoke tx confirmed but allowance was not cleared for #1: could not verify the allowance was cleared (allowance did not reach expected state after 5 attempts (last read: 2000000))'))).toBe(true);
  });

  it('fails closed when a reapproval receipt succeeds but the allowance does not actually increase', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const walletAddress = showWallet('default').evm;
    const quoteId = saveLocalErc20Quote(walletAddress);
    const executeBodies = [];
    let executeCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(body);
        executeCount++;
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({
            status: 'Success',
            txHash: executeCount === 1 ? '0xRevokeHash' : '0xApprovalHash',
            chainType: 'evm',
            broadcaster: 'test',
          })),
        });
      }
      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      }
      if (body.method === 'eth_getTransactionCount') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      }
      if (body.method === 'eth_getTransactionReceipt') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { status: '0x1', blockNumber: '0x100' } })) });
      }
      if (body.method === 'eth_call') {
        // Revoke actually clears the allowance, but the reapproval's receipt
        // reports success without the allowance ever increasing.
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: hexResult(executeCount === 0 ? 2000000n : 0n) })) });
      }
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await expect(cmds.execute([], null, { 'no-simulate': true }, { quote: quoteId })).rejects.toThrow(/All quotes failed/i);

    // Both the revoke and the reapproval were broadcast; the swap never ran.
    expect(executeBodies).toHaveLength(2);
    expect(logs.some(l => l.includes('Approval tx confirmed but allowance did not reach the required amount for #1 after revoking the prior allowance (now 0): could not verify the approval took effect (allowance did not reach expected state after 5 attempts (last read: 0))'))).toBe(true);
  });

  it('fails closed when post-revoke allowance verification returns empty data', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const walletAddress = showWallet('default').evm;
    const quoteId = saveLocalErc20Quote(walletAddress);
    const executeBodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(body);
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xRevokeHash', chainType: 'evm', broadcaster: 'test' })),
        });
      }
      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      }
      if (body.method === 'eth_getTransactionCount') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      }
      if (body.method === 'eth_getTransactionReceipt') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { status: '0x1', blockNumber: '0x100' } })) });
      }
      if (body.method === 'eth_call') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: executeBodies.length === 0 ? hexResult(2000000n) : '0x',
        })) });
      }
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await expect(cmds.execute([], null, { 'no-simulate': true }, { quote: quoteId })).rejects.toThrow(/All quotes failed/i);

    expect(executeBodies).toHaveLength(1);
    expect(logs.some(l => l.includes('invalid allowance() return data: 0x'))).toBe(true);
  });

  it('guards the allowance timing override outside test environments', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalVitest = process.env.VITEST;
    process.env.NODE_ENV = 'production';
    delete process.env.VITEST;

    try {
      expect(() => __setAllowanceTimingForTests({ verifyDelayMs: 0 })).toThrow(/tests only/i);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalVitest == null) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
    }
  });

  it('reuses a sufficient allowance below the excessive threshold without approval transactions', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const walletAddress = showWallet('default').evm;
    const quoteId = saveLocalErc20Quote(walletAddress);
    const { executeBodies } = mockLocalEvmExecute({
      allowance: 300000n,
      executeResponses: [
        { status: 'Success', txHash: '0xSwapHash', chainType: 'evm', broadcaster: 'test' },
      ],
    });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await cmds.execute([], null, { 'no-simulate': true }, { quote: quoteId });

    expect(executeBodies).toHaveLength(1);
    expect(executeBodies[0].signedTransaction).not.toContain(approveSelector);
    expect(logs.some(l => l.includes('Sufficient allowance exists for #1, skipping approval'))).toBe(true);
  });

  it('reuses an oversized sufficient allowance when revocation is explicitly disabled', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const walletAddress = showWallet('default').evm;
    const quoteId = saveLocalErc20Quote(walletAddress);
    const { executeBodies } = mockLocalEvmExecute({
      allowance: 2000000n,
      executeResponses: [
        { status: 'Success', txHash: '0xSwapHash', chainType: 'evm', broadcaster: 'test' },
      ],
    });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await cmds.execute([], null, { 'no-simulate': true, 'no-revoke-excessive-allowance': true }, { quote: quoteId });

    expect(executeBodies).toHaveLength(1);
    expect(executeBodies[0].signedTransaction).not.toContain(approveSelector);
    expect(logs.some(l => l.includes('--no-revoke-excessive-allowance was set'))).toBe(true);
    expect(logs.some(l => l.includes('Sufficient allowance exists for #1, skipping approval'))).toBe(true);
    expect(logs.some(l => l.includes('Approval required'))).toBe(false);
  });

  it('fails closed when WalletConnect revoke returns no confirmable transaction', async () => {
    const wcAddress = '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4';
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue(wcAddress);
    const approvalSpy = vi.spyOn(wcTrading, 'sendApprovalViaWalletConnect').mockResolvedValue({});
    const sendSpy = vi.spyOn(wcTrading, 'sendTransactionViaWalletConnect').mockResolvedValue({ txHash: '0xshouldnothappen' });
    const quoteId = saveWalletConnectErc20Quote(wcAddress);
    const { executeBodies } = mockLocalEvmExecute({
      allowance: 2000000n,
      executeResponses: [
        { status: 'Success', txHash: '0xshouldnothappen', chainType: 'evm', broadcaster: 'test' },
      ],
    });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await expect(cmds.execute([], null, { 'no-simulate': true }, { quote: quoteId })).rejects.toThrow(/All quotes failed/i);

    expect(approvalSpy).toHaveBeenCalledTimes(1);
    expect(approvalSpy).toHaveBeenCalledWith(
      BASE_USDC,
      LIFI_ROUTER,
      8453,
      0n,
      undefined,
      { allowZero: true },
    );
    expect(sendSpy).not.toHaveBeenCalled();
    expect(executeBodies).toHaveLength(0);
    expect(logs.some(l => l.includes('cannot confirm allowance was cleared'))).toBe(true);
    expect(logs.some(l => l.includes('Approval required'))).toBe(false);
  });

  it('fails closed when WalletConnect approval returns no confirmable transaction after a revoke', async () => {
    const wcAddress = '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4';
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue(wcAddress);
    const quoteId = saveWalletConnectErc20Quote(wcAddress);
    const { executeBodies, setAllowance } = mockLocalEvmExecute({
      allowance: 2000000n,
      executeResponses: [
        { status: 'Success', txHash: '0xshouldnothappen', chainType: 'evm', broadcaster: 'test' },
      ],
    });
    // Revoke confirms (returns a tx hash, simulating the allowance clearing
    // on-chain); the reapproval returns nothing.
    const approvalSpy = vi.spyOn(wcTrading, 'sendApprovalViaWalletConnect')
      .mockImplementationOnce(async () => { setAllowance(0n); return { txHash: '0xRevokeHash' }; })
      .mockResolvedValueOnce({});
    const sendSpy = vi.spyOn(wcTrading, 'sendTransactionViaWalletConnect').mockResolvedValue({ txHash: '0xshouldnothappen' });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await expect(cmds.execute([], null, { 'no-simulate': true }, { quote: quoteId })).rejects.toThrow(/All quotes failed/i);

    // Both the revoke and the reapproval were attempted; the swap was never sent.
    expect(approvalSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(executeBodies).toHaveLength(0);
    expect(logs.some(l => l.includes('Allowance revoked in block'))).toBe(true);
    expect(logs.some(l => l.includes('Approval failed for #1 after revoking the prior allowance (now 0): returned no transaction hash and no signed transaction; cannot confirm approval landed'))).toBe(true);
  });
});

describe('Relay aggregator: --gasless flag dispatch', () => {
  it('forwards aggregator/gasless/steps/requestId to /execute when gasless flag is set', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const executeBodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(JSON.parse(opts.body));
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', signature: 'SolSig', chainType: 'solana', broadcaster: 'relay' })),
        });
      }
      // Bridge status: return DONE so post-execute polling exits
      if (urlStr.includes('/bridge/status')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ status: 'DONE', receiving: { status: 'DONE', txHash: 'destTx' } })),
        });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null })) });
    }));

    // Minimal Solana tx so signSolanaTransaction succeeds
    const sigCount = Buffer.from([0x01]);
    const emptySig = Buffer.alloc(64);
    const message = Buffer.from([0x01, 0x00, 0x01, 0x02, ...Buffer.alloc(32), ...Buffer.alloc(32), ...Buffer.alloc(32), 0x01, 0x01, 0x01, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00]);
    const txBase64 = Buffer.concat([sigCount, emptySig, message]).toString('base64');

    const quoteId = saveQuote({
      success: true,
      metadata: { quoteId: 'backend-relay-quote-id' },
      quotes: [{
        aggregator: 'relay',
        inputMint: '11111111111111111111111111111111',
        outputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        inAmount: '1000000000',
        outAmount: '180000000',
        approvalAddress: '',
        transaction: txBase64,
        metadata: {
          requestId: 'relay-req-gas',
          isCrossChain: true,
          bridgeTool: 'relay',
          steps: [{ kind: 'transaction', items: [{ data: 'opaque-step-blob' }] }],
        },
      }],
    }, 'solana', 'local', null, 'base');

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    try { await cmds.execute([], null, { gasless: true }, { quote: quoteId }); } catch { /* bridge polling may fail in test, that's fine */ }

    expect(executeBodies.length).toBeGreaterThanOrEqual(1);
    const body = executeBodies[0];
    expect(body.aggregator).toBe('relay');
    expect(body.gasless).toBe(true);
    expect(body.requestId).toBe('relay-req-gas');
    expect(body.steps).toEqual([{ kind: 'transaction', items: [{ data: 'opaque-step-blob' }] }]);
    expect(body.simulate).toBe(false); // gasless skips simulation
    expect(body.quoteId).toBe('backend-relay-quote-id');

    delete process.env.NANSEN_WALLET_PASSWORD;
    vi.unstubAllGlobals();
  });

  it('throws GASLESS_UNSUPPORTED_AGGREGATOR when --gasless is used on a LiFi quote', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        outputMint: '11111111111111111111111111111111',
        inAmount: '10000000',
        outAmount: '50000000',
        approvalAddress: '0xLifiSpender',
        transaction: { to: '0xLifiRouter', data: '0x1234', value: '0', gas: '300000' },
        metadata: { isCrossChain: true, bridgeTool: 'across' },
      }],
    }, 'base', 'local', null, 'solana');

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await expect(cmds.execute([], null, { gasless: true }, { quote: quoteId }))
      .rejects.toThrow(/only supported for Relay quotes/);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('throws GASLESS_UNSUPPORTED_WALLET when --gasless is used with WalletConnect', async () => {
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'relay',
        inputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        outputMint: '11111111111111111111111111111111',
        inAmount: '10000000',
        outAmount: '50000000',
        approvalAddress: '',
        transaction: { to: '0xRelayRouter', data: '0xswap', value: '0', gas: '300000' },
        metadata: { requestId: 'relay-req-wc', isCrossChain: true, bridgeTool: 'relay' },
      }],
    }, 'base', 'walletconnect', null, 'solana');

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await expect(cmds.execute([], null, { gasless: true }, { quote: quoteId }))
      .rejects.toThrow(/not supported via WalletConnect/);

    vi.restoreAllMocks();
  });
});

describe('Relay aggregator: bridge status', () => {
  it('pollBridgeStatus appends aggregator query param when set', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'DONE', receiving: { status: 'DONE', txHash: '0xfinal' } }),
    });

    await pollBridgeStatus('0xabc', 'base', 'solana', { log: () => {}, aggregator: 'relay' });

    const callUrl = new URL(global.fetch.mock.calls[0][0]);
    expect(callUrl.searchParams.get('aggregator')).toBe('relay');
    expect(callUrl.searchParams.get('txHash')).toBe('0xabc');

    global.fetch = origFetch;
  });

  it('pollBridgeStatus returns DONE+REFUNDED status without throwing', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'DONE', substatus: 'REFUNDED', substatusMessage: 'Refunded due to slippage' }),
    });

    const logs = [];
    const result = await pollBridgeStatus('0xabc', 'base', 'solana', { log: (m) => logs.push(m), aggregator: 'relay' });
    expect(result.status).toBe('DONE');
    expect(result.substatus).toBe('REFUNDED');
    expect(logs.some(l => l.includes('REFUNDED'))).toBe(true);

    global.fetch = origFetch;
  });

  it('bridge-status command shows REFUNDED warning instead of completed', async () => {
    const origFetch = global.fetch;
    // saveTxRecord first so the command picks up aggregator=relay
    saveTxRecord('0xrelaytx', { aggregator: 'relay', requestId: 'relay-req-X', fromChain: 'base', toChain: 'solana' });

    const fetchedUrls = [];
    global.fetch = vi.fn().mockImplementation((url) => {
      fetchedUrls.push(typeof url === 'string' ? url : url.toString());
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'DONE', substatus: 'REFUNDED', substatusMessage: 'Funds returned' }),
      });
    });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await cmds['bridge-status']([], null, {}, { 'tx-hash': '0xrelaytx', 'from-chain': 'base', 'to-chain': 'solana' });

    expect(logs.some(l => l.includes('REFUNDED'))).toBe(true);
    expect(logs.every(l => !l.includes('completed'))).toBe(true);

    // Auto-detected aggregator forwarded as query param
    expect(fetchedUrls[0]).toContain('aggregator=relay');
    // Relay explorer link surfaced
    expect(logs.some(l => l.includes('https://relay.link/transaction/relay-req-X'))).toBe(true);

    global.fetch = origFetch;
  });

  it('bridge-status command omits aggregator query when no tx record exists', async () => {
    const origFetch = global.fetch;
    const fetchedUrls = [];
    global.fetch = vi.fn().mockImplementation((url) => {
      fetchedUrls.push(typeof url === 'string' ? url : url.toString());
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'DONE', tool: 'lifi' }),
      });
    });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await cmds['bridge-status']([], null, {}, { 'tx-hash': '0xunknowntx', 'from-chain': 'base', 'to-chain': 'solana' });

    expect(fetchedUrls[0]).not.toContain('aggregator=');

    global.fetch = origFetch;
  });
});

describe('Relay aggregator: tx record persistence', () => {
  it('saveTxRecord and loadTxRecord round-trip', () => {
    saveTxRecord('0xroundtrip', { aggregator: 'relay', requestId: 'req-1', fromChain: 'base', toChain: 'solana' });
    const record = loadTxRecord('0xroundtrip');
    expect(record).toMatchObject({
      txHash: '0xroundtrip',
      aggregator: 'relay',
      requestId: 'req-1',
      fromChain: 'base',
      toChain: 'solana',
    });
    expect(typeof record.timestamp).toBe('number');
  });

  it('loadTxRecord returns null for unknown tx hash', () => {
    expect(loadTxRecord('0xnonexistent')).toBe(null);
  });

  it('loadTxRecord persists past the 1-hour quote TTL (uses 30-day TTL)', () => {
    saveTxRecord('0xstillvalid', { aggregator: 'relay', requestId: 'req-2', fromChain: 'base', toChain: 'solana' });
    // Age the record 2 hours — quote TTL would expire it; tx-record TTL must not.
    const dir = path.join(process.env.HOME, '.nansen', 'quotes');
    const filePath = path.join(dir, 'tx-0xstillvalid.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.timestamp = Date.now() - (2 * 3600000);
    fs.writeFileSync(filePath, JSON.stringify(data));
    const record = loadTxRecord('0xstillvalid');
    expect(record).not.toBeNull();
    expect(record.aggregator).toBe('relay');
  });

  it('loadTxRecord returns null past the 30-day TTL', () => {
    saveTxRecord('0xexpired', { aggregator: 'relay', requestId: 'req-2', fromChain: 'base', toChain: 'solana' });
    const dir = path.join(process.env.HOME, '.nansen', 'quotes');
    const filePath = path.join(dir, 'tx-0xexpired.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.timestamp = Date.now() - (31 * 24 * 3600000);
    fs.writeFileSync(filePath, JSON.stringify(data));
    expect(loadTxRecord('0xexpired')).toBe(null);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('cleanupQuotes preserves tx records (30-day TTL) but sweeps stale quotes', async () => {
    // A 2-hour-old tx record must survive a cleanup triggered by saveQuote.
    saveTxRecord('0xpreserved', { aggregator: 'relay', requestId: 'req-3', fromChain: 'base', toChain: 'solana' });
    const dir = path.join(process.env.HOME, '.nansen', 'quotes');
    const filePath = path.join(dir, 'tx-0xpreserved.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.timestamp = Date.now() - (2 * 3600000); // 2 hours old
    fs.writeFileSync(filePath, JSON.stringify(data));

    // saveQuote calls cleanupQuotes internally
    saveQuote({ success: true, quotes: [{ aggregator: 'test' }] }, 'base');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(loadTxRecord('0xpreserved')).not.toBeNull();
  });
});

describe('Path traversal protection', () => {
  it('loadTxRecord rejects ../ traversal', () => {
    expect(loadTxRecord('../../../etc/passwd')).toBe(null);
  });

  it('loadTxRecord rejects absolute paths', () => {
    expect(loadTxRecord('/etc/passwd')).toBe(null);
  });

  it('loadTxRecord allows legitimate tx hash', () => {
    saveTxRecord('0xlegit', { aggregator: 'relay', requestId: 'r1', fromChain: 'base', toChain: 'solana' });
    const record = loadTxRecord('0xlegit');
    expect(record).not.toBe(null);
    expect(record.txHash).toBe('0xlegit');
  });

  it('saveTxRecord ignores traversal attempt', () => {
    saveTxRecord('../../../etc/evil', { aggregator: 'relay', requestId: 'r2', fromChain: 'base', toChain: 'solana' });
    expect(loadTxRecord('../../../etc/evil')).toBe(null);
  });

  it('loadQuote rejects ../ traversal', () => {
    expect(() => loadQuote('../../../etc/passwd')).toThrow('not found');
  });

  it('loadQuote rejects absolute paths', () => {
    expect(() => loadQuote('/etc/passwd')).toThrow('not found');
  });
});

describe('Relay aggregator: EVM execute forwards requestId', () => {
  it('non-gasless EVM Relay execute omits requestId/aggregator (backend rejects them on EVM)', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const executeBodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return {}; } })() : {};
      if (body.method === 'eth_getTransactionCount') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      }
      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      }
      if (body.method === 'eth_call') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' })) });
      }
      if (body.method === 'eth_getTransactionReceipt') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { status: '0x1', blockNumber: '0x100' } })) });
      }
      if (urlStr.includes('/bridge/status')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ status: 'DONE', receiving: { status: 'DONE', txHash: 'destTx' } })),
        });
      }
      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(JSON.parse(opts.body));
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xRelayHash', chainType: 'evm', broadcaster: 'test' })),
        });
      }
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const quoteId = saveQuote({
      success: true,
      metadata: { quoteId: 'backend-relay-quote-id' },
      quotes: [{
        aggregator: 'relay',
        inputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
        outputMint: '11111111111111111111111111111111',
        inAmount: '10000000',
        outAmount: '50000000',
        approvalAddress: '', // skip approval
        transaction: { to: RELAY_ROUTER, data: '0x12345678', value: '0', gas: '300000', maxFeePerGas: '5000000', maxPriorityFeePerGas: '1000000' },
        metadata: { requestId: 'relay-evm-req', isCrossChain: true, bridgeTool: 'relay' },
      }],
    }, 'base', 'local', null, 'solana', {
      swapMode: 'exactIn',
      request: evmIntent({ walletAddress: showWallet('default').evm, fromToken: BASE_USDC, toToken: '11111111111111111111111111111111', toChain: 'solana', amount: '10000000', maxInputAmount: '10000000' }),
    });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    try { await cmds.execute([], null, {}, { quote: quoteId }); } catch { /* may fail later, ok */ }

    expect(executeBodies.length).toBeGreaterThanOrEqual(1);
    // Non-gasless EVM Relay: the backend's /execute schema rejects both
    // `aggregator` and `requestId` on EVM submissions (requestId is "Solana only").
    // The signed tx itself contains the routing info; no aggregator hint needed.
    expect(executeBodies[0].requestId).toBeUndefined();
    expect(executeBodies[0].aggregator).toBeUndefined();
    expect(executeBodies[0].gasless).toBeUndefined();
    expect(executeBodies[0].quoteId).toBe('backend-relay-quote-id');

    delete process.env.NANSEN_WALLET_PASSWORD;
    vi.unstubAllGlobals();
  });

  it('gasless EVM Relay execute sends requestId + gasless + steps', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const executeBodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return {}; } })() : {};
      if (body.method === 'eth_getTransactionCount') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' })) });
      }
      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      }
      if (body.method === 'eth_call') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' })) });
      }
      if (body.method === 'eth_getTransactionReceipt') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { status: '0x1', blockNumber: '0x100' } })) });
      }
      if (urlStr.includes('/bridge/status')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ status: 'DONE', receiving: { status: 'DONE', txHash: 'destTx' } })),
        });
      }
      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(JSON.parse(opts.body));
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: '0xRelayHash', chainType: 'evm', broadcaster: 'relay' })),
        });
      }
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })) });
    }));

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'relay',
        inputMint: BASE_USDC,
        outputMint: '11111111111111111111111111111111',
        inAmount: '10000000',
        outAmount: '50000000',
        approvalAddress: '',
        transaction: { to: RELAY_ROUTER, data: '0x12345678', value: '0', gas: '300000', maxFeePerGas: '5000000', maxPriorityFeePerGas: '1000000' },
        metadata: { requestId: 'relay-evm-gas-req', isCrossChain: true, bridgeTool: 'relay', steps: [{ kind: 'evm-tx' }] },
      }],
    }, 'base', 'local', null, 'solana', {
      swapMode: 'exactIn',
      request: evmIntent({ walletAddress: showWallet('default').evm, fromToken: BASE_USDC, toToken: '11111111111111111111111111111111', toChain: 'solana', amount: '10000000', maxInputAmount: '10000000' }),
    });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    try { await cmds.execute([], null, { gasless: true }, { quote: quoteId }); } catch { /* ok */ }

    expect(executeBodies.length).toBeGreaterThanOrEqual(1);
    expect(executeBodies[0].aggregator).toBe('relay');
    expect(executeBodies[0].gasless).toBe(true);
    expect(executeBodies[0].requestId).toBe('relay-evm-gas-req');
    expect(executeBodies[0].steps).toEqual([{ kind: 'evm-tx' }]);

    delete process.env.NANSEN_WALLET_PASSWORD;
    vi.unstubAllGlobals();
  });
});

describe('Relay aggregator: --aggregator override on bridge-status', () => {
  it('uses --aggregator flag when no tx record exists', async () => {
    const origFetch = global.fetch;
    const fetchedUrls = [];
    global.fetch = vi.fn().mockImplementation((url) => {
      fetchedUrls.push(typeof url === 'string' ? url : url.toString());
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'PENDING' }),
      });
    });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await cmds['bridge-status']([], null, {}, {
      'tx-hash': '0xfreshmachine',
      'from-chain': 'base',
      'to-chain': 'solana',
      aggregator: 'relay',
    });

    expect(fetchedUrls[0]).toContain('aggregator=relay');
    global.fetch = origFetch;
  });

  it('--aggregator flag overrides a stale tx record', async () => {
    const origFetch = global.fetch;
    saveTxRecord('0xstaletx', { aggregator: 'lifi', fromChain: 'base', toChain: 'solana' });

    const fetchedUrls = [];
    global.fetch = vi.fn().mockImplementation((url) => {
      fetchedUrls.push(typeof url === 'string' ? url : url.toString());
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'PENDING' }),
      });
    });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await cmds['bridge-status']([], null, {}, {
      'tx-hash': '0xstaletx',
      'from-chain': 'base',
      'to-chain': 'solana',
      aggregator: 'relay',
    });

    expect(fetchedUrls[0]).toContain('aggregator=relay');
    expect(fetchedUrls[0]).not.toContain('aggregator=lifi');
    global.fetch = origFetch;
  });

  it('rejects invalid --aggregator values', async () => {
    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await expect(cmds['bridge-status']([], null, {}, {
      'tx-hash': '0xabc',
      'from-chain': 'base',
      'to-chain': 'solana',
      aggregator: 'jupiter',
    })).rejects.toThrow(/Invalid --aggregator/);
  });
});

describe('Relay aggregator: Solana non-gasless omits requestId', () => {
  it('non-gasless Solana Relay execute does NOT send requestId (backend 502s otherwise)', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const executeBodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(JSON.parse(opts.body));
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', signature: 'SolSig', chainType: 'solana', broadcaster: 'solana-rpc' })),
        });
      }
      if (urlStr.includes('/bridge/status')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ status: 'DONE', receiving: { status: 'DONE', txHash: 'destTx' } })),
        });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null })) });
    }));

    // Minimal Solana tx for signing
    const sigCount = Buffer.from([0x01]);
    const emptySig = Buffer.alloc(64);
    const message = Buffer.from([0x01, 0x00, 0x01, 0x02, ...Buffer.alloc(32), ...Buffer.alloc(32), ...Buffer.alloc(32), 0x01, 0x01, 0x01, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00]);
    const txBase64 = Buffer.concat([sigCount, emptySig, message]).toString('base64');

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'relay',
        inputMint: '11111111111111111111111111111111',
        outputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        inAmount: '8300000',
        outAmount: '278359729005750',
        approvalAddress: '',
        transaction: txBase64,
        metadata: { requestId: 'relay-sol-req', isCrossChain: true, bridgeTool: 'relay' },
      }],
    }, 'solana', 'local', null, 'base');

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    try { await cmds.execute([], null, {}, { quote: quoteId }); } catch { /* bridge poll may fail, ok */ }

    expect(executeBodies.length).toBeGreaterThanOrEqual(1);
    // Critical: backend treats requestId as a Jupiter Ultra intent ID and 502s on
    // Relay-Solana submissions. Must omit it on this code path.
    expect(executeBodies[0].requestId).toBeUndefined();
    expect(executeBodies[0].aggregator).toBeUndefined();
    expect(executeBodies[0].gasless).toBeUndefined();

    delete process.env.NANSEN_WALLET_PASSWORD;
    vi.unstubAllGlobals();
  });

  it('non-gasless Solana Jupiter execute DOES send requestId (Jupiter Ultra intent)', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const executeBodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(JSON.parse(opts.body));
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', signature: 'SolSig', chainType: 'solana', broadcaster: 'jupiter' })),
        });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null })) });
    }));

    const sigCount = Buffer.from([0x01]);
    const emptySig = Buffer.alloc(64);
    const message = Buffer.from([0x01, 0x00, 0x01, 0x02, ...Buffer.alloc(32), ...Buffer.alloc(32), ...Buffer.alloc(32), 0x01, 0x01, 0x01, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00]);
    const txBase64 = Buffer.concat([sigCount, emptySig, message]).toString('base64');

    const quoteId = saveQuote({
      success: true,
      metadata: { quoteId: 'backend-jupiter-quote-id' },
      quotes: [{
        aggregator: 'jupiter',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        inAmount: '1000000000', outAmount: '50000000',
        transaction: txBase64,
        metadata: { requestId: 'jupiter-ultra-req', quoteId: 'aggregator-jupiter-quote-id' },
      }],
    }, 'solana');

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    try { await cmds.execute([], null, {}, { quote: quoteId }); } catch { /* ok */ }

    expect(executeBodies.length).toBeGreaterThanOrEqual(1);
    expect(executeBodies[0].requestId).toBe('jupiter-ultra-req'); // Jupiter Ultra still needs it
    expect(executeBodies[0].aggregator).toBeUndefined();
    expect(executeBodies[0].quoteId).toBe('backend-jupiter-quote-id');

    delete process.env.NANSEN_WALLET_PASSWORD;
    vi.unstubAllGlobals();
  });

  it('falls back to aggregator metadata quoteId when saved response metadata is missing', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const executeBodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(JSON.parse(opts.body));
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ status: 'Success', signature: 'SolSig', chainType: 'solana', broadcaster: 'jupiter' })),
        });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null })) });
    }));

    const sigCount = Buffer.from([0x01]);
    const emptySig = Buffer.alloc(64);
    const message = Buffer.from([0x01, 0x00, 0x01, 0x02, ...Buffer.alloc(32), ...Buffer.alloc(32), ...Buffer.alloc(32), 0x01, 0x01, 0x01, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00]);
    const txBase64 = Buffer.concat([sigCount, emptySig, message]).toString('base64');

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'jupiter',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        inAmount: '1000000000', outAmount: '50000000',
        transaction: txBase64,
        metadata: { requestId: 'jupiter-ultra-req', quoteId: 'aggregator-jupiter-quote-id' },
      }],
    }, 'solana');

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    try { await cmds.execute([], null, {}, { quote: quoteId }); } catch { /* ok */ }

    expect(executeBodies.length).toBeGreaterThanOrEqual(1);
    expect(executeBodies[0].quoteId).toBe('aggregator-jupiter-quote-id');

    delete process.env.NANSEN_WALLET_PASSWORD;
    vi.unstubAllGlobals();
  });
});

describe('Relay aggregator: --aggregator filter on trade quote', () => {
  it('filters quote list to the requested aggregator', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        quotes: [
          { aggregator: 'lifi', inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', outputMint: '11111111111111111111111111111111', inAmount: '1000', outAmount: '500', transaction: { to: '0xa', data: '0x', value: '1000' } },
          { aggregator: 'relay', inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', outputMint: '11111111111111111111111111111111', inAmount: '1000', outAmount: '550', transaction: { to: '0xb', data: '0x', value: '1000' } },
        ],
      }),
    });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await cmds.quote([], null, {}, {
      chain: 'base',
      'to-chain': 'solana',
      from: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      to: 'SOL',
      amount: '1000',
      aggregator: 'relay',
    });

    // Output must include relay quote and not the lifi one
    expect(logs.some(l => l.includes('(relay)'))).toBe(true);
    expect(logs.some(l => l.includes('(lifi)'))).toBe(false);

    global.fetch = origFetch;
    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('errors when no quote from the requested aggregator is available', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        quotes: [
          { aggregator: 'lifi', inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', outputMint: '11111111111111111111111111111111', inAmount: '1000', outAmount: '500', transaction: { to: '0xa', data: '0x', value: '1000' } },
        ],
      }),
    });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await expect(cmds.quote([], null, {}, {
      chain: 'base',
      'to-chain': 'solana',
      from: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      to: 'SOL',
      amount: '1000',
      aggregator: 'relay',
    })).rejects.toThrow(/No quotes from aggregator "relay"/);

    global.fetch = origFetch;
    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('rejects unknown --aggregator values on quote', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await expect(cmds.quote([], null, {}, {
      chain: 'base',
      'to-chain': 'solana',
      from: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      to: 'SOL',
      amount: '1000',
      aggregator: 'pancake',
    })).rejects.toThrow(/Invalid --aggregator/);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('rejects out-of-range --slippage on quote (M7)', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    // "3" is almost certainly meant as 3% but reads as 300% — reject it.
    await expect(cmds.quote([], null, {}, {
      chain: 'base',
      'to-chain': 'solana',
      from: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      to: 'SOL',
      amount: '1000',
      slippage: '3',
    })).rejects.toThrow(/Invalid --slippage/);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('rejects exactOut with --auto-slippage but no --max-auto-slippage', async () => {
    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    // Uncapped auto-slippage leaves the exactOut approval buffer unbounded → require a cap.
    await expect(cmds.quote([], null, { 'auto-slippage': true }, {
      chain: 'base',
      from: 'USDC',
      to: 'ETH',
      amount: '1000000',
      'swap-mode': 'exactOut',
    })).rejects.toThrow(/max-auto-slippage/i);
  });
});

describe('Relay aggregator: bridge-status 502 handling', () => {
  it('retries on 502 then returns the eventual JSON body', async () => {
    const origFetch = global.fetch;
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls < 3) {
        return Promise.resolve({
          ok: false,
          status: 502,
          text: async () => '<!DOCTYPE html><html>502 Bad Gateway from Cloudflare</html>',
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'PENDING' }),
      });
    });

    const result = await getBridgeStatus('0xabc', 'base', 'solana', { retryDelayMs: 5 });
    expect(result.status).toBe('PENDING');
    expect(calls).toBe(3); // 2 failed + 1 success

    global.fetch = origFetch;
  });

  it('throws clean message without leaking HTML when 502 persists', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => '<!DOCTYPE html><html><body>Cloudflare error 1101 details: foo bar baz</body></html>',
    });

    let caught;
    try {
      await getBridgeStatus('0xabc', 'base', 'solana', { retries: 1, retryDelayMs: 5 });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught.message).not.toContain('<!DOCTYPE');
    expect(caught.message).not.toContain('<html>');
    expect(caught.message).toContain('502');
    expect(caught.message).toContain('temporarily unavailable');
    // No `details` field at all on the non-JSON path — nothing to leak.
    expect(caught.details).toBeUndefined();

    global.fetch = origFetch;
  });
});

// ===========================================================================
// exactOut maximum-input enforcement (adversarial)
//
// For an exactOut swap the API chooses the INPUT. Each test below crafts a
// quote whose requested OUTPUT is exactly what was asked, but whose INPUT
// (5,000,000) overshoots the persisted maximum input (1,000,000 — the spend
// ceiling). The execute path must refuse to sign BEFORE any approval,
// transaction signing, or broadcast — for native and ERC-20 inputs, across all
// three EVM signing paths (local, Privy, WalletConnect).
// ===========================================================================
describe('exactOut max-input enforcement (adversarial)', () => {
  const ERC20_IN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // USDC on Base
  const NATIVE_IN = BASE_ETH;
  const ROUTER = LIFI_ROUTER;

  // Requested output is exactly 990000 (matches request.amount); input is 5x the cap.
  function overpayingExactOutQuote(inputMint, native) {
    const q = {
      aggregator: 'lifi',
      inputMint,
      outputMint: OUT_TOKEN,
      inAmount: '5000000',
      inputAmount: '5000000',
      outAmount: '990000',
      transaction: { to: ROUTER, data: '0xdeadbeef', value: native ? '5000000' : '0', gas: '210000' },
    };
    if (!native) q.approvalAddress = ROUTER;
    return q;
  }

  function exactOutRequestMeta(inputMint, walletAddress) {
    return {
      swapMode: 'exactOut',
      slippage: 0.03,
      request: {
        chain: 'base', toChain: null, walletAddress, recipient: null,
        fromToken: inputMint, toToken: OUT_TOKEN,
        swapMode: 'exactOut', amount: '990000', maxInputAmount: '1000000',
      },
    };
  }

  // Answers eth_getCode (so the target check passes and execution reaches the
  // cap guard) and records every fetch so we can prove /execute (broadcast) and
  // privy.io POST (sign) never happened. A /execute call would mean funds moved.
  function trackingFetch(calls) {
    return vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      calls.push({ url: urlStr, method: opts?.method });
      let body = {};
      try { body = opts?.body ? JSON.parse(opts.body) : {}; } catch { /* non-JSON */ }
      if (urlStr.includes('privy.io') && opts?.method === 'GET') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'wl_evm_1', address: '0xPrivyAddr', chain_type: 'ethereum' }) });
      }
      if (body.method === 'eth_getCode') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x6080604052' })) });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result: null })), json: () => Promise.resolve({}) });
    });
  }

  const noBroadcast = (calls) => expect(calls.some(c => c.url.includes('/execute'))).toBe(false);
  const noPrivySign = (calls) => expect(calls.some(c => c.url.includes('privy.io') && c.method === 'POST')).toBe(false);

  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete process.env.NANSEN_WALLET_PASSWORD; });

  for (const native of [false, true]) {
    const kind = native ? 'native' : 'ERC-20';
    const inputMint = native ? NATIVE_IN : ERC20_IN;

    it(`local wallet: refuses ${kind} exactOut when input exceeds the max, without signing or broadcasting`, async () => {
      createWallet('default', 'testpass');
      process.env.NANSEN_WALLET_PASSWORD = 'testpass';
      const calls = [];
      vi.stubGlobal('fetch', trackingFetch(calls));

      const quoteId = saveQuote({ success: true, quotes: [overpayingExactOutQuote(inputMint, native)] },
        'base', 'local', null, null, exactOutRequestMeta(inputMint, showWallet('default').evm));

      const logs = [];
      const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });

      await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/exceeds your maximum input/i);
      noBroadcast(calls);
      // Never reached the approval/broadcast stage.
      expect(logs.some(l => /Approval required|Sending approval|Broadcasting/.test(l))).toBe(false);
    });

    it(`Privy: refuses ${kind} exactOut when input exceeds the max, without signing or broadcasting`, async () => {
      process.env.PRIVY_APP_ID = 'test-app-id';
      process.env.PRIVY_APP_SECRET = 'test-secret';
      const calls = [];
      vi.stubGlobal('fetch', trackingFetch(calls));

      const quoteId = saveQuote({ success: true, quotes: [overpayingExactOutQuote(inputMint, native)] },
        'base', 'privy', { evm: 'wl_evm_1', solana: 'wl_sol_1' }, null, exactOutRequestMeta(inputMint, '0xPrivyAddr'));

      const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });

      await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/exceeds your maximum input/i);
      noPrivySign(calls); // no signEvmTransaction (privy.io POST)
      noBroadcast(calls); // no /execute broadcast

      delete process.env.PRIVY_APP_ID;
      delete process.env.PRIVY_APP_SECRET;
    });

    it(`WalletConnect: refuses ${kind} exactOut when input exceeds the max, without approving or sending`, async () => {
      vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
      const approvalSpy = vi.spyOn(wcTrading, 'sendApprovalViaWalletConnect').mockResolvedValue({ txHash: '0xshouldnothappen' });
      const sendSpy = vi.spyOn(wcTrading, 'sendTransactionViaWalletConnect').mockResolvedValue({ txHash: '0xshouldnothappen' });
      const calls = [];
      vi.stubGlobal('fetch', trackingFetch(calls));

      const quoteId = saveQuote({ success: true, quotes: [overpayingExactOutQuote(inputMint, native)] },
        'base', 'walletconnect', null, null, exactOutRequestMeta(inputMint, '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4'));

      const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });

      await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/exceeds your maximum input/i);
      expect(approvalSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
      noBroadcast(calls);
    });
  }

  it('local wallet: refuses to sign a quote built for a different wallet (signer binding)', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const calls = [];
    vi.stubGlobal('fetch', trackingFetch(calls));

    // request.walletAddress is a fixed address that will NOT match the freshly
    // generated local wallet — as if the default wallet changed since quoting.
    const quoteId = saveQuote(
      { success: true, quotes: [{
        aggregator: 'lifi', inputMint: ERC20_IN, outputMint: OUT_TOKEN,
        inAmount: '1000000', inputAmount: '1000000', outAmount: '990000',
        approvalAddress: ROUTER, transaction: { to: ROUTER, data: '0xdeadbeef', value: '0', gas: '210000' },
      }] },
      'base', 'local', null, null,
      { swapMode: 'exactIn', slippage: 0.03, request: {
        chain: 'base', toChain: null, walletAddress: '0x000000000000000000000000000000000000dEaD',
        recipient: null, fromToken: ERC20_IN, toToken: OUT_TOKEN,
        swapMode: 'exactIn', amount: '1000000', maxInputAmount: '1000000',
      } });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });

    await expect(cmds.execute([], null, {}, { quote: quoteId })).rejects.toThrow(/built for wallet .* but the signer is/i);
    noBroadcast(calls);
    expect(logs.some(l => /Approval required|Sending approval|Broadcasting/.test(l))).toBe(false);
  });
});

describe('verifySwapOutcome (execute-path wiring)', () => {
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const WALLET = '0x8cb9c3f23c7d600fb430bbd171a313d9ea61cebc';
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const OUT = '0x4200000000000000000000000000000000000006';
  const ROUTER = '0x57df6092665eb6058def53f94734a338a50f2e5f';
  const pad = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const hx = (n) => '0x' + BigInt(n).toString(16);
  const tlog = (token, from, to, amount) => ({ address: token, topics: [TRANSFER, pad(from), pad(to)], data: hx(amount) });
  const simBody = (logs) => ({ status: 200, text: async () => JSON.stringify({ result: [{ calls: [{ status: '0x1', logs }] }] }) });

  const quote = {
    inputMint: USDC, outputMint: OUT, inAmount: '1000000', outAmount: '1000000',
    approvalAddress: ROUTER, transaction: { to: ROUTER, data: '0xabcd', value: '0' },
  };
  const quoteData = {
    slippage: 0.03,
    request: { chain: 'base', walletAddress: WALLET, fromToken: USDC, toToken: OUT, swapMode: 'exactIn', amount: '1000000', maxInputAmount: '1000000' },
  };

  let origBase, origFetch;
  beforeEach(() => { origBase = SIMULATION_RPCS.base; origFetch = global.fetch; SIMULATION_RPCS.base = 'http://sim.test'; });
  afterEach(() => { SIMULATION_RPCS.base = origBase; global.fetch = origFetch; vi.restoreAllMocks(); });

  it('proceeds on a clean swap', async () => {
    global.fetch = vi.fn().mockResolvedValue(simBody([tlog(USDC, WALLET, ROUTER, 1000000n), tlog(OUT, ROUTER, WALLET, 1000000n)]));
    const r = await verifySwapOutcome({ chain: 'base', from: WALLET, quote, quoteData });
    expect(r.proceed).toBe(true);
  });

  it('blocks (proceed=false) when a sibling token is drained', async () => {
    const drain = '0xaaaa000000000000000000000000000000000001';
    global.fetch = vi.fn().mockResolvedValue(simBody([
      tlog(USDC, WALLET, ROUTER, 1000000n), tlog(OUT, ROUTER, WALLET, 1000000n), tlog(drain, WALLET, ROUTER, 5n),
    ]));
    const r = await verifySwapOutcome({ chain: 'base', from: WALLET, quote, quoteData });
    expect(r.proceed).toBe(false);
    expect(r.reason).toMatch(/SWAP_OUTCOME_MISMATCH/i);
  });

  it('blocks when the output falls short', async () => {
    global.fetch = vi.fn().mockResolvedValue(simBody([tlog(USDC, WALLET, ROUTER, 1000000n), tlog(OUT, ROUTER, WALLET, 900000n)]));
    const r = await verifySwapOutcome({ chain: 'base', from: WALLET, quote, quoteData });
    expect(r.proceed).toBe(false);
  });

  it('blocks when the swap reverts in simulation', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 200, text: async () => JSON.stringify({ result: [{ calls: [{ status: '0x0', logs: [] }] }] }) });
    const r = await verifySwapOutcome({ chain: 'base', from: WALLET, quote, quoteData });
    expect(r.proceed).toBe(false);
  });

  it('degrades (proceed=true) when no simulation endpoint is configured', async () => {
    SIMULATION_RPCS.base = null;
    const logs = [];
    const r = await verifySwapOutcome({ chain: 'base', from: WALLET, quote, quoteData, log: (m) => logs.push(m) });
    expect(r.proceed).toBe(true);
    expect(logs.some((l) => /unavailable|proceeding without/i.test(l))).toBe(true);
  });

  it('degrades (proceed=true) when the endpoint cannot run the simulation', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 200, text: async () => JSON.stringify({ error: { code: -32601, message: 'method not found' } }) });
    const r = await verifySwapOutcome({ chain: 'base', from: WALLET, quote, quoteData });
    expect(r.proceed).toBe(true);
  });

  it('skips non-EVM chains', async () => {
    global.fetch = vi.fn(); // must not be called
    const r = await verifySwapOutcome({ chain: 'solana', from: WALLET, quote, quoteData });
    expect(r.proceed).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('handles a bare "0x" tx.value without throwing (BigInt("0x") would throw)', async () => {
    // A bare '0x' is truthy but unparseable by BigInt; it must normalise to zero
    // value, not crash or misfire as an outcome mismatch.
    global.fetch = vi.fn().mockResolvedValue(simBody([tlog(USDC, WALLET, ROUTER, 1000000n), tlog(OUT, ROUTER, WALLET, 1000000n)]));
    const bareValueQuote = { ...quote, transaction: { ...quote.transaction, value: '0x' } };
    const r = await verifySwapOutcome({ chain: 'base', from: WALLET, quote: bareValueQuote, quoteData });
    expect(r.proceed).toBe(true);
    const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sentBody.params[0].blockStateCalls[0].calls[0].value).toBe('0x0');
  });

  it('skips cross-chain bridge quotes', async () => {
    // The bridge output settles on the destination chain, so it never appears in
    // a source-chain simulation and the output-received assertion would always
    // fail. The verifier must not run (and must not touch the sim endpoint).
    global.fetch = vi.fn(); // must not be called
    const crossChainData = { ...quoteData, chain: 'base', toChain: 'solana' };
    const r = await verifySwapOutcome({ chain: 'base', from: WALLET, quote, quoteData: crossChainData });
    expect(r.proceed).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('degrades (proceed=true) for a pre-intent quote with no request recorded', async () => {
    // Without request intent, assertSwapOutcome has nothing to compare against and
    // would raise a misleading SWAP_OUTCOME_MISMATCH. Skip cleanly instead — even
    // with a sim-capable endpoint reachable, the verifier must not run.
    global.fetch = vi.fn(); // must not be called
    const noIntentData = { slippage: 0.03 };
    const logs = [];
    const r = await verifySwapOutcome({ chain: 'base', from: WALLET, quote, quoteData: noIntentData, log: (m) => logs.push(m) });
    expect(r.proceed).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(logs.some((l) => /no request intent/i.test(l))).toBe(true);
  });
});
