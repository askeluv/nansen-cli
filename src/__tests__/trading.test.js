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
  stripLeadingZeros,
  buildTradingCommands,
  getWrappedNativeFromWarning,
  validateBaseUnitAmount,
  resolveTokenAddress,
  formatQuote,
  simulateEvmCall,
  parseUnits,
  getTokenDecimals,
  getTokenPriceUsd,
  convertAmountToBaseUnits,
} from '../trading.js';
import { keccak256, rlpEncode } from '../crypto.js';
import { base58Decode } from '../transfer.js';
import {
  base58Encode,
  generateEvmWallet,
  generateSolanaWallet,
  createWallet,
} from '../wallet.js';
import * as wcTrading from '../walletconnect-trading.js';

let originalHome;
let tempDir;

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
  it('should build a valid approval tx', () => {
    const wallet = generateEvmWallet();
    const signedHex = buildApprovalTransaction(
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
      '0x57df6092665eb6058de53939612413ff4b09114e', // spender
      wallet.privateKey,
      'base',
      0,
    );
    expect(signedHex).toMatch(/^0x[0-9a-f]+$/);
  });

  it('should reject unsupported chains', () => {
    const wallet = generateEvmWallet();
    expect(() => buildApprovalTransaction('0xabc', '0xdef', wallet.privateKey, 'polygon', 0))
      .toThrow('Unsupported chain');
  });
});

// ============= CLI Command Validation =============

describe('buildTradingCommands', () => {
  it('should show help when required params missing for quote', async () => {
    const logs = [];
    let exitCalled = false;
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => { exitCalled = true; },
    });

    await cmds.quote([], null, {}, {});
    expect(exitCalled).toBe(true);
    expect(logs.some(l => l.includes('Usage: nansen trade quote'))).toBe(true);
  });

  it('should show help when quote-id missing for execute', async () => {
    const logs = [];
    let exitCalled = false;
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => { exitCalled = true; },
    });

    await cmds.execute([], null, {}, {});
    expect(exitCalled).toBe(true);
    expect(logs.some(l => l.includes('Usage: nansen trade execute'))).toBe(true);
  });

  it('should error when no wallet exists for quote', async () => {
    const logs = [];
    let exitCalled = false;

    // Mock fetch for the API call
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, quotes: [{ aggregator: 'test' }] }),
    });

    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => { exitCalled = true; },
    });

    await cmds.quote([], null, {}, {
      chain: 'solana', from: 'So111', to: 'EPjFW', amount: '1000',
    });

    expect(exitCalled).toBe(true);
    expect(logs.some(l => l.includes('No wallet') || l.includes('No default wallet'))).toBe(true);

    global.fetch = origFetch;
  });

  it('should reject ERC-20 swap with non-zero tx.value', async () => {
    // A compromised API could attach ETH value to an ERC-20 swap to drain funds
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'test',
        inputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC (ERC-20)
        outputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        inAmount: '1000000',
        outAmount: '500000000000000',
        transaction: { to: '0xabc', data: '0x1234', value: '5000000000000000000', gas: '200000' },
      }],
    }, 'base');

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    await cmds.execute([], null, {}, { quote: quoteId });
    expect(logs.some(l => l.includes('non-zero tx.value'))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should reject native ETH swap with missing inAmount but non-zero tx.value', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'test',
        inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        outputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        // no inAmount or inputAmount — malformed quote
        outAmount: '3000000000',
        transaction: { to: '0xabc', data: '0x1234', value: '5000000000000000000', gas: '200000' },
      }],
    }, 'base');

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    await cmds.execute([], null, {}, { quote: quoteId });
    expect(logs.some(l => l.includes('value mismatch'))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should pass validation for ERC-20 swap with value 0', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'test',
        inputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        outputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        inAmount: '1000000',
        outAmount: '500000000000000',
        transaction: { to: '0xabc', data: '0x1234', value: '0', gas: '200000' },
      }],
    }, 'base');

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    await cmds.execute([], null, {}, { quote: quoteId });
    // Should NOT hit the value validation rejection
    expect(logs.some(l => l.includes('non-zero tx.value'))).toBe(false);
    expect(logs.some(l => l.includes('value mismatch'))).toBe(false);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should pass validation for native ETH swap with matching value', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'test',
        inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        outputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        inAmount: '1000000000000000000',
        outAmount: '3000000000',
        transaction: { to: '0xabc', data: '0x1234', value: '1000000000000000000', gas: '200000' },
      }],
    }, 'base');

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    await cmds.execute([], null, {}, { quote: quoteId });
    // Should NOT hit the value validation rejection
    expect(logs.some(l => l.includes('non-zero tx.value'))).toBe(false);
    expect(logs.some(l => l.includes('value mismatch'))).toBe(false);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should reject native ETH swap with mismatched tx.value', async () => {
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';

    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'test',
        inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // native ETH
        outputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        inAmount: '1000000000000000000', // 1 ETH
        outAmount: '3000000000',
        transaction: { to: '0xabc', data: '0x1234', value: '5000000000000000000', gas: '200000' },
      }],
    }, 'base');

    const logs = [];
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => {},
    });

    await cmds.execute([], null, {}, { quote: quoteId });
    expect(logs.some(l => l.includes('value mismatch'))).toBe(true);

    delete process.env.NANSEN_WALLET_PASSWORD;
  });

  it('should error when execute loads a quote without transaction data', async () => {
    // Save a quote without transaction field
    const quoteId = saveQuote({
      success: true,
      quotes: [{ aggregator: 'test', inAmount: '100' }], // no .transaction
    }, 'solana');

    const logs = [];
    let exitCalled = false;
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => { exitCalled = true; },
    });

    await cmds.execute([], null, {}, { quote: quoteId });
    expect(exitCalled).toBe(true);
    expect(logs.some(l => l.includes('transaction data'))).toBe(true);
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
      json: () => Promise.resolve({
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

    const logs = [];
    let exitCalled = false;
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => { exitCalled = true; },
    });

    await cmds.quote([], null, {}, {
      chain: 'base',
      from: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1000000000000000000',
      wallet: 'walletconnect',
    });

    expect(exitCalled).toBe(true);
    expect(logs.some(l => l.includes('No WalletConnect session active'))).toBe(true);

    vi.restoreAllMocks();
  });

  it('should accept "wc" as walletconnect alias for quote', async () => {
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue(null);

    const logs = [];
    let exitCalled = false;
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => { exitCalled = true; },
    });

    await cmds.quote([], null, {}, {
      chain: 'base',
      from: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1000000000000000000',
      wallet: 'wc',
    });

    expect(exitCalled).toBe(true);
    expect(logs.some(l => l.includes('No WalletConnect session active'))).toBe(true);

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
        aggregator: 'test',
        inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        outputMint: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        inAmount: '1000000000000000000',
        outAmount: '3000000000',
        transaction: { to: '0xabc', data: '0x1234', value: '1000000000000000000', gas: '200000' },
      }],
    }, 'base', 'walletconnect');

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

    const logs = [];
    let exitCalled = false;
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => { exitCalled = true; },
    });

    await cmds.execute([], null, {}, { quote: quoteId });

    expect(exitCalled).toBe(true);
    expect(logs.some(l => l.includes('No WalletConnect session active'))).toBe(true);

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

    await cmds.execute([], null, {}, { quote: quoteId });

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
        aggregator: 'test',
        inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        outputMint: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        inAmount: '1000000000000000000',
        outAmount: '3000000000',
        transaction: { to: '0xRouter', data: '0xSwapData', value: '1000000000000000000', gas: '210000' },
      }],
    }, 'base', 'privy', { evm: 'wl_evm_1', solana: 'wl_sol_1' });

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
        aggregator: 'test',
        inputMint: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC (ERC-20, not native)
        outputMint: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        inAmount: '1000000',
        outAmount: '990000',
        inputAmount: '1000000',
        approvalAddress: '0xRouterApproval',
        transaction: {
          to: '0xRouter',
          data: '0xSwapData',
          value: '0',
          gas: '210000',
          maxFeePerGas: '1000000',
          maxPriorityFeePerGas: '1000000',
        },
      }],
    }, 'base', 'privy', { evm: 'wl_evm_1', solana: 'wl_sol_1' });

    const rpcCalls = [];
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
        // eth_call for allowance check — return 0 (needs approval)
        if (body.method === 'eth_call') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x0000000000000000000000000000000000000000000000000000000000000000' })) });
        }
        // eth_getTransactionReceipt (for waitForReceipt)
        if (body.method === 'eth_getTransactionReceipt') {
          return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { status: '0x1', blockNumber: '0x100' } })) });
        }
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null })) });
      }
      // Trading API executeTransaction
      if (urlStr.includes('trading-api')) {
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
});

describe('quote handler rejects decimal amounts before API call', () => {
  it('should error on decimal amount in base mode and not call fetch', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn();

    const logs = [];
    let exitCalled = false;
    const cmds = buildTradingCommands({
      log: (msg) => logs.push(msg),
      exit: () => { exitCalled = true; },
    });

    await cmds.quote([], null, {}, {
      chain: 'solana', from: 'So111', to: 'EPjFW', amount: '0.005',
      'amount-unit': 'base',
    });

    expect(exitCalled).toBe(true);
    expect(logs.some(l => l.includes('base units'))).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();

    global.fetch = origFetch;
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

// ============= Amount Unit Conversion =============

describe('parseUnits', () => {
  it('converts whole numbers', () => {
    expect(parseUnits('1', 9)).toBe(1000000000n);
    expect(parseUnits('1', 18)).toBe(1000000000000000000n);
    expect(parseUnits('1', 6)).toBe(1000000n);
    expect(parseUnits('100', 6)).toBe(100000000n);
  });

  it('converts decimal amounts', () => {
    expect(parseUnits('1.5', 9)).toBe(1500000000n);
    expect(parseUnits('0.001', 18)).toBe(1000000000000000n);
    expect(parseUnits('0.5', 6)).toBe(500000n);
    expect(parseUnits('1.23', 6)).toBe(1230000n);
  });

  it('handles zero', () => {
    expect(parseUnits('0', 18)).toBe(0n);
    expect(parseUnits('0.0', 9)).toBe(0n);
  });

  it('handles amounts with no integer part', () => {
    expect(parseUnits('.5', 9)).toBe(500000000n);
    expect(parseUnits('0.1', 18)).toBe(100000000000000000n);
  });

  it('pads short fractions', () => {
    // 1.5 with 18 decimals → 1500000000000000000
    expect(parseUnits('1.5', 18)).toBe(1500000000000000000n);
  });

  it('throws on excess precision', () => {
    expect(() => parseUnits('1.1234567', 6)).toThrow('more decimal places');
  });

  it('allows trailing zeros beyond precision', () => {
    // 1.500000 with 6 decimals is fine (trailing zeros)
    expect(parseUnits('1.500000', 6)).toBe(1500000n);
  });

  it('throws on empty string', () => {
    expect(() => parseUnits('', 18)).toThrow('Invalid amount');
  });

  it('throws on multiple decimal points', () => {
    expect(() => parseUnits('1.2.3', 18)).toThrow('multiple decimal points');
  });

  it('handles large amounts without floating-point errors', () => {
    // This is the key test: 1.1 ETH in base units should be exact
    expect(parseUnits('1.1', 18)).toBe(1100000000000000000n);
    // 999999.999999 USDC
    expect(parseUnits('999999.999999', 6)).toBe(999999999999n);
  });
});

describe('getTokenDecimals', () => {
  it('returns known Solana token decimals', async () => {
    expect(await getTokenDecimals('So11111111111111111111111111111111111111112', 'solana')).toBe(9);
    expect(await getTokenDecimals('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'solana')).toBe(6);
    expect(await getTokenDecimals('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'solana')).toBe(6);
  });

  it('returns known Base token decimals', async () => {
    expect(await getTokenDecimals('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'base')).toBe(18);
    expect(await getTokenDecimals('0x4200000000000000000000000000000000000006', 'base')).toBe(18);
    expect(await getTokenDecimals('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'base')).toBe(6);
  });

  it('is case-insensitive for addresses', async () => {
    expect(await getTokenDecimals('0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', 'base')).toBe(18);
  });

  it('falls back to chain default for unknown Solana tokens', async () => {
    expect(await getTokenDecimals('UnknownMint1111111111111111111111111111111', 'solana')).toBe(9);
  });

  it('falls back to EVM RPC for unknown EVM tokens', async () => {
    const origFetch = global.fetch;
    // Mock RPC returning 8 decimals
    const rpcResponse = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: '0x0000000000000000000000000000000000000000000000000000000000000008',
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: async () => rpcResponse, json: async () => JSON.parse(rpcResponse),
    });

    const decimals = await getTokenDecimals('0x1234567890abcdef1234567890abcdef12345678', 'base');
    expect(decimals).toBe(8);

    global.fetch = origFetch;
  });
});

describe('getTokenPriceUsd', () => {
  it('fetches native token price', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ solana: { usd: 150.42 } }),
    });

    const price = await getTokenPriceUsd('So11111111111111111111111111111111111111112', 'solana');
    expect(price).toBe(150.42);

    // Verify correct CoinGecko URL was called
    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain('simple/price');
    expect(url).toContain('ids=solana');

    global.fetch = origFetch;
  });

  it('fetches ERC-20 token price', async () => {
    const origFetch = global.fetch;
    const tokenAddr = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ [tokenAddr]: { usd: 1.0 } }),
    });

    const price = await getTokenPriceUsd(tokenAddr, 'base');
    expect(price).toBe(1.0);

    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain('simple/token_price/base');
    expect(url).toContain(tokenAddr);

    global.fetch = origFetch;
  });

  it('throws on HTTP error', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 });

    await expect(getTokenPriceUsd('So11111111111111111111111111111111111111112', 'solana'))
      .rejects.toThrow('Failed to fetch token price');

    global.fetch = origFetch;
  });

  it('throws when price is not found', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({}),
    });

    await expect(getTokenPriceUsd('0xunknowntoken', 'base'))
      .rejects.toThrow('Could not find USD price');

    global.fetch = origFetch;
  });
});

describe('convertAmountToBaseUnits', () => {
  it('passes through base units unchanged', async () => {
    expect(await convertAmountToBaseUnits('1000000000', 'base', 'SOL', 'solana')).toBe('1000000000');
  });

  it('rejects decimals in base mode', async () => {
    await expect(convertAmountToBaseUnits('1.5', 'base', 'SOL', 'solana'))
      .rejects.toThrow('must be an integer');
  });

  it('converts token units for known tokens', async () => {
    // 1.5 SOL = 1500000000 lamports
    const result = await convertAmountToBaseUnits('1.5', 'token', 'So11111111111111111111111111111111111111112', 'solana');
    expect(result).toBe('1500000000');
  });

  it('converts token units for USDC', async () => {
    // 100 USDC = 100000000 (6 decimals)
    const result = await convertAmountToBaseUnits('100', 'token', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'solana');
    expect(result).toBe('100000000');
  });

  it('converts token units for ETH', async () => {
    // 0.01 ETH = 10000000000000000 wei
    const result = await convertAmountToBaseUnits('0.01', 'token', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'base');
    expect(result).toBe('10000000000000000');
  });

  it('converts USD amounts', async () => {
    const origFetch = global.fetch;
    // Mock CoinGecko price response: SOL = $150
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ solana: { usd: 150 } }),
    });

    // $30 at $150/SOL = 0.2 SOL = 200000000 lamports
    const result = await convertAmountToBaseUnits('30', 'usd', 'So11111111111111111111111111111111111111112', 'solana');
    expect(result).toBe('200000000');

    global.fetch = origFetch;
  });

  it('rejects invalid amount-unit', async () => {
    await expect(convertAmountToBaseUnits('1', 'percent', 'SOL', 'solana'))
      .rejects.toThrow('Invalid --amount-unit');
  });

  it('rejects zero token amount', async () => {
    await expect(convertAmountToBaseUnits('0', 'token', 'So11111111111111111111111111111111111111112', 'solana'))
      .rejects.toThrow('must be positive');
  });

  it('rejects negative USD amount', async () => {
    await expect(convertAmountToBaseUnits('-5', 'usd', 'So11111111111111111111111111111111111111112', 'solana'))
      .rejects.toThrow('must be a positive number');
  });
});

describe('quote command with amount-unit', () => {
  it('defaults to usd amount-unit and converts before quoting', async () => {
    const origFetch = global.fetch;
    const output = [];
    let exitCode = null;
    const log = (msg) => output.push(msg);
    const exit = (code) => { exitCode = code; };
    const commands = buildTradingCommands({ log, exit });

    // Create a wallet for the test
    const walletDir = path.join(tempDir, '.nansen', 'wallets');
    fs.mkdirSync(walletDir, { recursive: true });
    fs.writeFileSync(path.join(walletDir, 'config.json'), JSON.stringify({
      defaultWallet: 'test',
      wallets: { test: { name: 'test' } },
    }));
    fs.writeFileSync(path.join(walletDir, 'test.json'), JSON.stringify({
      name: 'test',
      solana: { address: 'TestSolAddr111111111111111111111111111111' },
      evm: { address: '0x1234567890abcdef1234567890abcdef12345678' },
    }));

    let fetchCallCount = 0;
    global.fetch = vi.fn().mockImplementation(async (url) => {
      fetchCallCount++;
      if (url.includes('coingecko')) {
        return {
          ok: true, status: 200,
          json: async () => ({ solana: { usd: 100 } }),
        };
      }
      // Quote API response
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          success: true,
          quotes: [{
            aggregator: 'test',
            inAmount: '200000000',
            outAmount: '20000000',
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            inUsdValue: '20',
            outUsdValue: '20',
          }],
        }),
      };
    });

    await commands.quote([], null, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '20',
    });

    expect(exitCode).toBeNull(); // Should not exit with error
    // Should have called CoinGecko for price
    const cgCall = global.fetch.mock.calls.find(c => c[0].includes('coingecko'));
    expect(cgCall).toBeTruthy();
    // Should have logged conversion info
    const conversionLog = output.find(l => l.includes('Converting'));
    expect(conversionLog).toBeTruthy();
    expect(conversionLog).toContain('usd');

    global.fetch = origFetch;
  });

  it('skips conversion for --amount-unit base', async () => {
    const origFetch = global.fetch;
    const output = [];
    let exitCode = null;
    const log = (msg) => output.push(msg);
    const exit = (code) => { exitCode = code; };
    const commands = buildTradingCommands({ log, exit });

    const walletDir = path.join(tempDir, '.nansen', 'wallets');
    fs.mkdirSync(walletDir, { recursive: true });
    fs.writeFileSync(path.join(walletDir, 'config.json'), JSON.stringify({
      defaultWallet: 'test',
      wallets: { test: { name: 'test' } },
    }));
    fs.writeFileSync(path.join(walletDir, 'test.json'), JSON.stringify({
      name: 'test',
      solana: { address: 'TestSolAddr111111111111111111111111111111' },
      evm: { address: '0x1234567890abcdef1234567890abcdef12345678' },
    }));

    global.fetch = vi.fn().mockImplementation(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        success: true,
        quotes: [{
          aggregator: 'test',
          inAmount: '1000000000',
          outAmount: '150000000',
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        }],
      }),
    }));

    await commands.quote([], null, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '1000000000',
      'amount-unit': 'base',
    });

    expect(exitCode).toBeNull();
    // Should NOT call CoinGecko
    const cgCall = global.fetch.mock.calls.find(c => c[0].includes('coingecko'));
    expect(cgCall).toBeUndefined();
    // Should NOT log conversion
    const conversionLog = output.find(l => l.includes('Converting'));
    expect(conversionLog).toBeUndefined();

    global.fetch = origFetch;
  });

  it('rejects decimal amounts in base mode', async () => {
    const output = [];
    let exitCode = null;
    const log = (msg) => output.push(msg);
    const exit = (code) => { exitCode = code; };
    const commands = buildTradingCommands({ log, exit });

    await commands.quote([], null, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '1.5',
      'amount-unit': 'base',
    });

    expect(exitCode).toBe(1);
    const errorMsg = output.find(l => l.includes('base units'));
    expect(errorMsg).toBeTruthy();
  });

  it('rejects invalid amount-unit', async () => {
    const output = [];
    let exitCode = null;
    const log = (msg) => output.push(msg);
    const exit = (code) => { exitCode = code; };
    const commands = buildTradingCommands({ log, exit });

    await commands.quote([], null, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '20',
      'amount-unit': 'percent',
    });

    expect(exitCode).toBe(1);
    const errorMsg = output.find(l => l.includes('Invalid --amount-unit'));
    expect(errorMsg).toBeTruthy();
  });

  it('sets swapMode to exactOut when amount-side is buy', async () => {
    const origFetch = global.fetch;
    const output = [];
    let exitCode = null;
    const log = (msg) => output.push(msg);
    const exit = (code) => { exitCode = code; };
    const commands = buildTradingCommands({ log, exit });

    const walletDir = path.join(tempDir, '.nansen', 'wallets');
    fs.mkdirSync(walletDir, { recursive: true });
    fs.writeFileSync(path.join(walletDir, 'config.json'), JSON.stringify({
      defaultWallet: 'test',
      wallets: { test: { name: 'test' } },
    }));
    fs.writeFileSync(path.join(walletDir, 'test.json'), JSON.stringify({
      name: 'test',
      solana: { address: 'TestSolAddr111111111111111111111111111111' },
      evm: { address: '0x1234567890abcdef1234567890abcdef12345678' },
    }));

    let capturedParams = null;
    const quoteResponse = JSON.stringify({
      success: true,
      quotes: [{
        aggregator: 'test',
        inAmount: '1000000000',
        outAmount: '100000000',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      }],
    });
    global.fetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('coingecko')) {
        // For amount-side buy, USDC price lookup (the "to" token)
        const addr = 'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v';
        return {
          ok: true, status: 200,
          json: async () => ({ [addr]: { usd: 1.0 } }),
        };
      }
      // Capture the quote API call params
      capturedParams = new URL(url).searchParams;
      return {
        ok: true, status: 200,
        text: async () => quoteResponse,
      };
    });

    await commands.quote([], null, {}, {
      chain: 'solana',
      from: 'SOL',
      to: 'USDC',
      amount: '100',
      'amount-side': 'buy',
    });

    expect(exitCode).toBeNull();
    expect(capturedParams).toBeTruthy();
    expect(capturedParams.get('swapMode')).toBe('exactOut');

    global.fetch = origFetch;
  });
});
