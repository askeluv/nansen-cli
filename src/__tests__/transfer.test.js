/**
 * Transfer Tests — unit + integration coverage
 */

import { test, expect, vi, beforeEach, describe } from 'vitest';
import crypto from 'crypto';
import {
  sendTokens,
  parseAmount,
  signEd25519,
  encodeCompactU16,
  base58Decode,
  base58DecodePubkey,
  deriveATA,
  validateEvmAddress,
  validateSolanaAddress,
  bigIntToHex,
  buildUnsignedSolanaTransaction,
} from '../transfer.js';
import { signSecp256k1, rlpEncode } from '../crypto.js';
import { base58Encode } from '../wallet.js';
import * as wallet from '../wallet.js';
import * as wcTrading from '../walletconnect-trading.js';


// ============= Unit Tests =============

describe('RLP Encoding', () => {
  test('encodes empty string as 0x80', () => {
    expect(rlpEncode('0x')).toEqual(Buffer.from([0x80]));
  });

  test('encodes single byte < 0x80 as itself', () => {
    expect(rlpEncode('0x7f')).toEqual(Buffer.from([0x7f]));
  });

  test('encodes single byte 0x80 with length prefix', () => {
    expect(rlpEncode('0x80')).toEqual(Buffer.from([0x81, 0x80]));
  });

  test('encodes short string with length prefix', () => {
    const result = rlpEncode('0xdeadbeef');
    expect(result[0]).toBe(0x80 + 4); // length prefix
    expect(result.subarray(1).toString('hex')).toBe('deadbeef');
  });

  test('encodes zero as empty byte string', () => {
    expect(rlpEncode('0x0')).toEqual(Buffer.from([0x80]));
    expect(rlpEncode('0x')).toEqual(Buffer.from([0x80]));
  });

  test('encodes list', () => {
    const result = rlpEncode(['0x01', '0x02']);
    expect(result[0]).toBe(0xc0 + 2); // list prefix + length
  });

  test('encodes empty list', () => {
    expect(rlpEncode([])).toEqual(Buffer.from([0xc0]));
  });

  test('encodes nested list', () => {
    const result = rlpEncode([['0x01'], '0x02']);
    expect(result[0]).toBeGreaterThanOrEqual(0xc0);
  });

  test('strips leading zeros from hex', () => {
    const result = rlpEncode('0x0001');
    expect(result).toEqual(Buffer.from([0x01])); // single byte 1
  });
});

describe('Amount Parsing', () => {
  test('parses whole numbers', () => {
    expect(parseAmount('1', 18)).toBe(1000000000000000000n);
    expect(parseAmount('1', 9)).toBe(1000000000n);
    expect(parseAmount('1', 6)).toBe(1000000n);
  });

  test('parses decimals', () => {
    expect(parseAmount('1.5', 18)).toBe(1500000000000000000n);
    expect(parseAmount('0.1', 9)).toBe(100000000n);
    expect(parseAmount('0.000001', 6)).toBe(1n);
  });

  test('parses small amounts correctly', () => {
    expect(parseAmount('0.0001', 18)).toBe(100000000000000n);
    expect(parseAmount('0.005', 9)).toBe(5000000n);
  });

  test('truncates excess decimals', () => {
    // 6 decimal token, input has 9 decimals — should truncate
    expect(parseAmount('1.123456789', 6)).toBe(1123456n);
  });

  test('pads short decimals', () => {
    expect(parseAmount('1.1', 18)).toBe(1100000000000000000n);
  });
});

describe('Address Validation', () => {
  test('validates correct EVM addresses', () => {
    expect(validateEvmAddress('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4').valid).toBe(true);
    expect(validateEvmAddress('0x0000000000000000000000000000000000000000').valid).toBe(true);
  });

  test('rejects bad EVM addresses', () => {
    expect(validateEvmAddress('not-an-address').valid).toBe(false);
    expect(validateEvmAddress('0x123').valid).toBe(false);
    expect(validateEvmAddress('').valid).toBe(false);
    expect(validateEvmAddress(null).valid).toBe(false);
  });

  test('validates correct Solana addresses', () => {
    expect(validateSolanaAddress('11111111111111111111111111111111').valid).toBe(true);
    expect(validateSolanaAddress('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM').valid).toBe(true);
  });

  test('rejects bad Solana addresses', () => {
    expect(validateSolanaAddress('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4').valid).toBe(false);
    expect(validateSolanaAddress('').valid).toBe(false);
  });
});

describe('Base58', () => {
  test('decodes known Solana system program', () => {
    const decoded = base58Decode('11111111111111111111111111111111');
    expect(decoded.length).toBe(32);
    expect(decoded.every(b => b === 0)).toBe(true);
  });

  test('round-trips with base58Encode', () => {
    const original = crypto.randomBytes(32);
    const encoded = base58Encode(original);
    const decoded = base58DecodePubkey(encoded);
    expect(decoded.toString('hex')).toBe(original.toString('hex'));
  });

  test('base58DecodePubkey pads to 32 bytes', () => {
    // '1' in base58 = single zero byte, should pad to 32
    const result = base58DecodePubkey('1');
    expect(result.length).toBe(32);
  });
});

describe('Compact-u16 Encoding', () => {
  test('encodes single-byte values', () => {
    expect(encodeCompactU16(0)).toEqual(Buffer.from([0]));
    expect(encodeCompactU16(1)).toEqual(Buffer.from([1]));
    expect(encodeCompactU16(127)).toEqual(Buffer.from([127]));
  });

  test('encodes two-byte values', () => {
    const buf = encodeCompactU16(128);
    expect(buf.length).toBe(2);
    expect(buf[0] & 0x80).toBe(0x80);
  });

  test('encodes 256 correctly', () => {
    const buf = encodeCompactU16(256);
    expect(buf.length).toBe(2);
    expect(buf[0]).toBe(0x80);
    expect(buf[1]).toBe(2);
  });
});

describe('secp256k1 ECDSA Signing', () => {
  // Use a known private key
  const privKey = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');

  test('produces 32-byte r and s', () => {
    const hash = crypto.randomBytes(32);
    const sig = signSecp256k1(hash, privKey);
    expect(sig.r.length).toBe(32);
    expect(sig.s.length).toBe(32);
  });

  test('v is 0 or 1', () => {
    const hash = crypto.randomBytes(32);
    const sig = signSecp256k1(hash, privKey);
    expect([0, 1]).toContain(sig.v);
  });

  test('produces different signatures for different hashes', () => {
    const sig1 = signSecp256k1(crypto.randomBytes(32), privKey);
    const sig2 = signSecp256k1(crypto.randomBytes(32), privKey);
    expect(sig1.r.toString('hex')).not.toBe(sig2.r.toString('hex'));
  });

  test('is deterministic (RFC 6979)', () => {
    const hash = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'hex');
    const sig1 = signSecp256k1(hash, privKey);
    const sig2 = signSecp256k1(hash, privKey);
    expect(sig1.r.toString('hex')).toBe(sig2.r.toString('hex'));
    expect(sig1.s.toString('hex')).toBe(sig2.s.toString('hex'));
  });

  test('low-S normalization (EIP-2)', () => {
    // Run multiple signatures and verify s is always in the lower half
    const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
    const halfN = N >> 1n;
    for (let i = 0; i < 10; i++) {
      const hash = crypto.randomBytes(32);
      const sig = signSecp256k1(hash, privKey);
      const s = BigInt('0x' + sig.s.toString('hex'));
      expect(s <= halfN).toBe(true);
    }
  });
});

describe('Ed25519 Signing', () => {
  test('produces 64-byte signature', () => {
    const { publicKey: _publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const seed = privateKey.subarray(privateKey.length - 32);
    const message = Buffer.from('hello world');
    const sig = signEd25519(message, seed);
    expect(sig.length).toBe(64);
  });

  test('is deterministic', () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const seed = privateKey.subarray(privateKey.length - 32);
    const message = Buffer.from('test message');
    const sig1 = signEd25519(message, seed);
    const sig2 = signEd25519(message, seed);
    expect(sig1.toString('hex')).toBe(sig2.toString('hex'));
  });

  test('different messages produce different signatures', () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const seed = privateKey.subarray(privateKey.length - 32);
    const sig1 = signEd25519(Buffer.from('msg1'), seed);
    const sig2 = signEd25519(Buffer.from('msg2'), seed);
    expect(sig1.toString('hex')).not.toBe(sig2.toString('hex'));
  });
});

describe('ATA Derivation', () => {
  test('produces a 32-byte result', () => {
    const ata = deriveATA(
      '11111111111111111111111111111111',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    );
    expect(ata.length).toBe(32);
  });

  test('is deterministic', () => {
    const ata1 = deriveATA('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const ata2 = deriveATA('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    expect(ata1.toString('hex')).toBe(ata2.toString('hex'));
  });

  test('different owners produce different ATAs', () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const prog = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const ata1 = deriveATA('11111111111111111111111111111111', mint, prog);
    const ata2 = deriveATA('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', mint, prog);
    expect(ata1.toString('hex')).not.toBe(ata2.toString('hex'));
  });
});

describe('bigIntToHex', () => {
  test('encodes zero as empty', () => {
    expect(bigIntToHex(0n)).toBe('0x');
  });

  test('encodes small values', () => {
    expect(bigIntToHex(1n)).toBe('0x1');
    expect(bigIntToHex(255n)).toBe('0xff');
  });

  test('encodes large values', () => {
    expect(bigIntToHex(8453n)).toBe('0x2105');
  });
});

// ============= Integration Tests =============

global.fetch = vi.fn();

describe('sendTokens integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(wallet, 'getWalletConfig').mockReturnValue({
      defaultWallet: 'test',
      passwordHash: { salt: 'test', hash: 'test' },
    });
    vi.spyOn(wallet, 'verifyPassword').mockReturnValue(true);
    vi.spyOn(wallet, 'showWallet').mockReturnValue({
      name: 'test',
      provider: 'local',
      evm: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
      solana: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    });
    vi.spyOn(wallet, 'exportWallet').mockReturnValue({
      name: 'test',
      evm: { address: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', privateKey: '0123456789abcdef'.repeat(4) },
      solana: { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', privateKey: '0123456789abcdef'.repeat(8) },
    });
  });

  describe('EVM', () => {
    // Smart mock that responds based on the RPC method
    function mockEvmRpcSmart() {
      fetch.mockImplementation(async (url, opts) => {
        const body = JSON.parse(opts.body);
        const responses = {
          'eth_getTransactionCount': '0x5',
          'eth_feeHistory': { baseFeePerGas: ['0x3b9aca00','0x3b9aca00','0x3b9aca00','0x3b9aca00','0x3b9aca00'] },
          'eth_maxPriorityFeePerGas': '0x5F5E100', // 0.1 gwei
          'eth_getBalance': '0x8AC7230489E80000', // 10 ETH
          'eth_estimateGas': '0x5208', // 21000
          'eth_sendRawTransaction': '0xabc123',
          'eth_getTransactionReceipt': { status: '0x1', blockNumber: '0x100' },
          'eth_getCode': '0x6080604052', // non-empty bytecode
          'eth_call': '0x' + 'f'.repeat(64), // large balance for balanceOf, or decimals
        };
        return { json: () => Promise.resolve({ result: responses[body.method] || '0x0' }) };
      });
    }

    test('sends native ETH and returns tx hash', async () => {
      mockEvmRpcSmart();
      const result = await sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '0.01', chain: 'evm', password: 'test' });
      expect(result.success).toBe(true);
      expect(result.transactionHash).toBe('0xabc123');
      expect(result.chain).toBe('evm');
      expect(result.token).toBeNull();
    });

    test('fetches nonce with both "pending" and "latest" for gap check', async () => {
      mockEvmRpcSmart();
      await sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '0.01', chain: 'evm', password: 'test' });
      const nonceCalls = fetch.mock.calls
        .map(([, opts]) => JSON.parse(opts.body))
        .filter(b => b.method === 'eth_getTransactionCount');
      const tags = nonceCalls.map(b => b.params[1]);
      expect(tags).toContain('pending');
      expect(tags).toContain('latest');
    });

    test('rejects when too many transactions are already queued (stuck nonce guard)', async () => {
      fetch.mockImplementation(async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.method === 'eth_getTransactionCount') {
          // pending = 5, latest = 2 → gap of 3 > MAX_PENDING_NONCE_GAP (2)
          return { json: () => Promise.resolve({ result: body.params[1] === 'pending' ? '0x5' : '0x2' }) };
        }
        return { json: () => Promise.resolve({ result: '0x0' }) };
      });
      await expect(
        sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '0.01', chain: 'evm', password: 'test' }),
      ).rejects.toThrow(
        /unmined transactions queued[\s\S]*Wait for them to clear[\s\S]*load-balanced public RPC/,
      );
      await expect(
        sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '0.01', chain: 'evm', password: 'test' }),
      ).rejects.not.toThrow(/Replace the stuck transaction|--nonce|--priority-fee/);
    });

    test('sends on Base chain', async () => {
      mockEvmRpcSmart();
      const result = await sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '0.01', chain: 'base', password: 'test' });
      expect(result.chain).toBe('base');
    });

    test('sends ERC-20 with correct decimals fetch', async () => {
      let ethCallCount = 0;
      fetch.mockImplementation(async (url, opts) => {
        const body = JSON.parse(opts.body);
        const responses = {
          'eth_getTransactionCount': '0x0',
          'eth_feeHistory': { baseFeePerGas: ['0x1','0x1','0x1','0x1','0x1'] },
          'eth_maxPriorityFeePerGas': '0x5F5E100',
          'eth_estimateGas': '0xfe00',
          'eth_sendRawTransaction': '0xtoken_tx',
          'eth_getTransactionReceipt': { status: '0x1', blockNumber: '0x100' },
          'eth_getCode': '0x6080604052',
        };
        if (body.method === 'eth_call') {
          ethCallCount++;
          // First eth_call = decimals (from validateErc20Token), second = balanceOf
          if (ethCallCount === 1) return { json: () => Promise.resolve({ result: '0x0000000000000000000000000000000000000000000000000000000000000012' }) };
          return { json: () => Promise.resolve({ result: '0x' + 'f'.repeat(64) }) };
        }
        return { json: () => Promise.resolve({ result: responses[body.method] || '0x0' }) };
      });

      const result = await sendTokens({
        to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '100', chain: 'evm',
        token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', password: 'test',
      });
      expect(result.success).toBe(true);
      expect(result.token).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    });

    test('builds valid EIP-1559 type 2 transaction', async () => {
      mockEvmRpcSmart();
      await sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '0.01', chain: 'evm', password: 'test' });

      // Find the sendRawTransaction call
      const sendRawCall = fetch.mock.calls.find(c => JSON.parse(c[1].body).method === 'eth_sendRawTransaction');
      expect(sendRawCall).toBeDefined();
      expect(JSON.parse(sendRawCall[1].body).params[0]).toMatch(/^0x02/);
    });

    test('uses eth_estimateGas instead of hardcoded gas limit', async () => {
      mockEvmRpcSmart();
      await sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '0.01', chain: 'evm', password: 'test' });

      const estimateCall = fetch.mock.calls.find(c => JSON.parse(c[1].body).method === 'eth_estimateGas');
      expect(estimateCall).toBeDefined();
    });

    test('rejects when ETH balance is insufficient', async () => {
      fetch.mockImplementation(async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.method === 'eth_getBalance') return { json: () => Promise.resolve({ result: '0x0' }) };
        if (body.method === 'eth_getTransactionCount') return { json: () => Promise.resolve({ result: '0x0' }) };
        if (body.method === 'eth_feeHistory') return { json: () => Promise.resolve({ result: { baseFeePerGas: ['0x3b9aca00','0x3b9aca00','0x3b9aca00','0x3b9aca00','0x3b9aca00'] } }) };
        if (body.method === 'eth_maxPriorityFeePerGas') return { json: () => Promise.resolve({ result: '0x5F5E100' }) };
        return { json: () => Promise.resolve({ result: '0x0' }) };
      });

      await expect(sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '1.0', chain: 'evm', password: 'test' }))
        .rejects.toThrow('Insufficient ETH balance');
    });

    test('rejects when ERC-20 balance is insufficient', async () => {
      let ethCallCount = 0;
      fetch.mockImplementation(async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.method === 'eth_getCode') return { json: () => Promise.resolve({ result: '0x6080604052' }) };
        if (body.method === 'eth_call') {
          ethCallCount++;
          // First call = decimals (from validateErc20Token), second = balanceOf
          if (ethCallCount === 1) return { json: () => Promise.resolve({ result: '0x0000000000000000000000000000000000000000000000000000000000000006' }) };
          return { json: () => Promise.resolve({ result: '0x0' }) }; // balanceOf = 0
        }
        if (body.method === 'eth_getTransactionCount') return { json: () => Promise.resolve({ result: '0x0' }) };
        if (body.method === 'eth_feeHistory') return { json: () => Promise.resolve({ result: { baseFeePerGas: ['0x1','0x1','0x1','0x1','0x1'] } }) };
        if (body.method === 'eth_maxPriorityFeePerGas') return { json: () => Promise.resolve({ result: '0x5F5E100' }) };
        return { json: () => Promise.resolve({ result: '0x0' }) };
      });

      await expect(sendTokens({
        to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '100', chain: 'evm',
        token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', password: 'test',
      })).rejects.toThrow('Insufficient token balance');
    });
  });

  describe('Solana', () => {
    function mockSolRpcSmart() {
      fetch.mockImplementation(async (url, opts) => {
        const body = JSON.parse(opts.body);
        const responses = {
          'getLatestBlockhash': { value: { blockhash: 'GHtXQBpokWApVtJPBteD6jHQJPMBpfDY4PPnSr3DSEJQ' } },
          'getBalance': { value: 1000000000 }, // 1 SOL
          'sendTransaction': 'sol_sig_123',
          'getSignatureStatuses': { value: [{ confirmationStatus: 'confirmed', slot: 12345, err: null }] },
        };
        return { json: () => Promise.resolve({ result: responses[body.method] || null }) };
      });
    }

    test('sends native SOL', async () => {
      mockSolRpcSmart();
      const result = await sendTokens({ to: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', amount: '0.5', chain: 'solana', password: 'test' });
      expect(result.success).toBe(true);
      expect(result.transactionHash).toBe('sol_sig_123');
    });

    test('broadcasts base64-encoded transaction', async () => {
      mockSolRpcSmart();
      await sendTokens({ to: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', amount: '0.5', chain: 'solana', password: 'test' });

      const sendCall = fetch.mock.calls.find(c => JSON.parse(c[1].body).method === 'sendTransaction');
      const body = JSON.parse(sendCall[1].body);
      expect(body.params[1].encoding).toBe('base64');
      expect(() => Buffer.from(body.params[0], 'base64')).not.toThrow();
    });

    test('rejects when SOL balance is insufficient', async () => {
      fetch.mockImplementation(async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.method === 'getLatestBlockhash') return { json: () => Promise.resolve({ result: { value: { blockhash: 'GHtXQBpokWApVtJPBteD6jHQJPMBpfDY4PPnSr3DSEJQ' } } }) };
        if (body.method === 'getBalance') return { json: () => Promise.resolve({ result: { value: 100 } }) };
        return { json: () => Promise.resolve({ result: null }) };
      });

      await expect(sendTokens({ to: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', amount: '1.0', chain: 'solana', password: 'test' }))
        .rejects.toThrow('Insufficient SOL balance');
    });
  });

  describe('Error handling', () => {
    test('rejects invalid EVM address', async () => {
      await expect(sendTokens({ to: 'bad', amount: '1', chain: 'evm', password: 'test' })).rejects.toThrow('Invalid recipient');
    });

    test('rejects invalid Solana address', async () => {
      await expect(sendTokens({ to: '0xBadAddress', amount: '1', chain: 'solana', password: 'test' })).rejects.toThrow('Invalid recipient');
    });

    test('rejects wrong password', async () => {
      vi.spyOn(wallet, 'verifyPassword').mockReturnValue(false);
      await expect(sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '1', chain: 'evm', password: 'wrong' })).rejects.toThrow('Incorrect password');
    });

    test('rejects when no default wallet', async () => {
      vi.spyOn(wallet, 'getWalletConfig').mockReturnValue({ defaultWallet: null, passwordHash: {} });
      await expect(sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '1', chain: 'evm', password: 'test' })).rejects.toThrow('No wallet');
    });

    test('propagates RPC errors', async () => {
      fetch.mockImplementation(async () => ({ json: () => Promise.resolve({ error: { message: 'insufficient lamports on account' } }) }));
      await expect(sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '1', chain: 'evm', password: 'test' })).rejects.toThrow('Insufficient SOL balance');
    });

    test('propagates network errors', async () => {
      fetch.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '1', chain: 'evm', password: 'test' })).rejects.toThrow('ECONNREFUSED');
    });

    test('uses specified wallet name', async () => {
      fetch.mockImplementation(async (url, opts) => {
        const body = JSON.parse(opts.body);
        const r = {
          'eth_getTransactionCount': '0x0',
          'eth_feeHistory': { baseFeePerGas: ['0x1','0x1','0x1','0x1','0x1'] },
          'eth_getBalance': '0x8AC7230489E80000',
          'eth_estimateGas': '0x5208',
          'eth_sendRawTransaction': '0x1',
        };
        return { json: () => Promise.resolve({ result: r[body.method] || '0x0' }) };
      });

      await sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '0.001', chain: 'evm', wallet: 'my-wallet', password: 'test' });
      expect(wallet.exportWallet).toHaveBeenCalledWith('my-wallet', 'test');
    });
  });
});

// ============= WalletConnect Transfer Tests =============

describe('sendTokens via WalletConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('rejects Solana + walletconnect for transfers with clear message', async () => {
    await expect(sendTokens({
      to: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      amount: '0.5',
      chain: 'solana',
      walletconnect: true,
    })).rejects.toThrow('WalletConnect Solana transfers are not yet supported. Use a local wallet for Solana transfers.');
  });

  test('errors when no WalletConnect session', async () => {
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue(null);

    await expect(sendTokens({
      to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
      amount: '0.1',
      chain: 'evm',
      walletconnect: true,
    })).rejects.toThrow('No WalletConnect session active');

    vi.restoreAllMocks();
  });

  test('skips password verification for walletconnect', async () => {
    const exportSpy = vi.spyOn(wallet, 'exportWallet');
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    vi.spyOn(wcTrading, 'sendTransactionViaWalletConnect').mockResolvedValue({ txHash: '0xmocktx123' });

    // Mock RPC calls for native transfer
    fetch.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      const r = {
        'eth_getTransactionReceipt': { status: '0x1', blockNumber: '0x100' },
      };
      return { json: () => Promise.resolve({ result: r[body.method] || '0x0' }) };
    });

    const result = await sendTokens({
      to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
      amount: '0.1',
      chain: 'evm',
      walletconnect: true,
      // no password provided
    });

    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('0xmocktx123');
    expect(result.from).toBe('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    // Should NOT have called exportWallet
    expect(exportSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  test('dry run with walletconnect returns tx data', async () => {
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');

    const result = await sendTokens({
      to: '0x1234567890123456789012345678901234567890',
      amount: '0.5',
      chain: 'evm',
      walletconnect: true,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.from).toBe('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    expect(result.to).toBe('0x1234567890123456789012345678901234567890');
    expect(result.amount).toBe('0.5');

    vi.restoreAllMocks();
  });

  test('sends native ETH via walletconnect', async () => {
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    vi.spyOn(wcTrading, 'sendTransactionViaWalletConnect').mockResolvedValue({ txHash: '0xnativetx' });

    fetch.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      const r = {
        'eth_getTransactionReceipt': { status: '0x1', blockNumber: '0x200' },
      };
      return { json: () => Promise.resolve({ result: r[body.method] || '0x0' }) };
    });

    const result = await sendTokens({
      to: '0x1234567890123456789012345678901234567890',
      amount: '1.0',
      chain: 'evm',
      walletconnect: true,
    });

    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('0xnativetx');

    // Verify sendTransactionViaWalletConnect was called with correct params
    const call = wcTrading.sendTransactionViaWalletConnect.mock.calls[0][0];
    expect(call.to).toBe('0x1234567890123456789012345678901234567890');
    expect(call.data).toBe('0x');
    expect(call.value).toBe('1000000000000000000'); // 1 ETH in wei

    vi.restoreAllMocks();
  });

  test('sends ERC-20 via walletconnect', async () => {
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    vi.spyOn(wcTrading, 'sendTransactionViaWalletConnect').mockResolvedValue({ txHash: '0xerc20tx' });

    const tokenAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

    fetch.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.method === 'eth_getCode') {
        return { json: () => Promise.resolve({ result: '0x608060' }) }; // contract exists
      }
      if (body.method === 'eth_call') {
        // decimals() returns 6
        return { json: () => Promise.resolve({ result: '0x0000000000000000000000000000000000000000000000000000000000000006' }) };
      }
      if (body.method === 'eth_getTransactionReceipt') {
        return { json: () => Promise.resolve({ result: { status: '0x1', blockNumber: '0x300' } }) };
      }
      return { json: () => Promise.resolve({ result: '0x0' }) };
    });

    const result = await sendTokens({
      to: '0x1234567890123456789012345678901234567890',
      amount: '100',
      chain: 'evm',
      token: tokenAddress,
      walletconnect: true,
    });

    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('0xerc20tx');

    // Verify the transfer calldata
    const call = wcTrading.sendTransactionViaWalletConnect.mock.calls[0][0];
    expect(call.to).toBe(tokenAddress);
    expect(call.data).toMatch(/^0xa9059cbb/); // transfer selector
    expect(call.value).toBe('0');

    vi.restoreAllMocks();
  });

  test('sends max native ETH via walletconnect', async () => {
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    vi.spyOn(wcTrading, 'sendTransactionViaWalletConnect').mockResolvedValue({ txHash: '0xmaxtx' });

    fetch.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.method === 'eth_getBalance') {
        return { json: () => Promise.resolve({ result: '0xDE0B6B3A7640000' }) }; // 1 ETH
      }
      if (body.method === 'eth_estimateGas') {
        return { json: () => Promise.resolve({ result: '0x5208' }) }; // 21000
      }
      if (body.method === 'eth_feeHistory') {
        return { json: () => Promise.resolve({ result: { baseFeePerGas: ['0x3B9ACA00', '0x3B9ACA00'] } }) }; // 1 gwei
      }
      if (body.method === 'eth_getTransactionReceipt') {
        return { json: () => Promise.resolve({ result: { status: '0x1', blockNumber: '0x400' } }) };
      }
      return { json: () => Promise.resolve({ result: '0x0' }) };
    });

    const result = await sendTokens({
      to: '0x1234567890123456789012345678901234567890',
      chain: 'evm',
      walletconnect: true,
      max: true,
    });

    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('0xmaxtx');
    // Should have sent less than 1 ETH (reserved for gas)
    const call = wcTrading.sendTransactionViaWalletConnect.mock.calls[0][0];
    expect(call.data).toBe('0x');
    expect(BigInt(call.value)).toBeLessThan(1000000000000000000n);
    expect(BigInt(call.value)).toBeGreaterThan(0n);

    vi.restoreAllMocks();
  });

  test('sends max ERC-20 via walletconnect', async () => {
    vi.spyOn(wcTrading, 'getWalletConnectAddress').mockResolvedValue('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    vi.spyOn(wcTrading, 'sendTransactionViaWalletConnect').mockResolvedValue({ txHash: '0xmaxerc20' });

    const tokenAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

    fetch.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.method === 'eth_getCode') {
        return { json: () => Promise.resolve({ result: '0x608060' }) };
      }
      if (body.method === 'eth_call') {
        const data = body.params?.[0]?.data;
        if (data?.startsWith('0x313ce567')) {
          // decimals() → 6
          return { json: () => Promise.resolve({ result: '0x0000000000000000000000000000000000000000000000000000000000000006' }) };
        }
        if (data?.startsWith('0x70a08231')) {
          // balanceOf() → 500 USDC (500 * 10^6)
          return { json: () => Promise.resolve({ result: '0x' + (500000000n).toString(16).padStart(64, '0') }) };
        }
      }
      if (body.method === 'eth_estimateGas') {
        return { json: () => Promise.resolve({ result: '0x10000' }) }; // 65536
      }
      if (body.method === 'eth_getTransactionReceipt') {
        return { json: () => Promise.resolve({ result: { status: '0x1', blockNumber: '0x500' } }) };
      }
      return { json: () => Promise.resolve({ result: '0x0' }) };
    });

    const result = await sendTokens({
      to: '0x1234567890123456789012345678901234567890',
      chain: 'evm',
      token: tokenAddress,
      walletconnect: true,
      max: true,
    });

    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('0xmaxerc20');

    // Verify transfer calldata contains full balance (500 USDC = 500000000)
    const call = wcTrading.sendTransactionViaWalletConnect.mock.calls[0][0];
    expect(call.to).toBe(tokenAddress);
    expect(call.data).toMatch(/^0xa9059cbb/);
    expect(call.value).toBe('0');

    vi.restoreAllMocks();
  });
});

// ============= buildUnsignedSolanaTransaction =============

describe('buildUnsignedSolanaTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns unsigned transaction with empty signature slot', async () => {
    fetch.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.method === 'getLatestBlockhash') {
        return {
          json: () => Promise.resolve({
            result: {
              value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 },
              context: { slot: 1 },
            },
          }),
        };
      }
      if (body.method === 'getBalance') {
        return {
          json: () => Promise.resolve({
            result: { value: 1000000000, context: { slot: 1 } },
          }),
        };
      }
      return { json: () => Promise.resolve({ result: null }) };
    });

    const result = await buildUnsignedSolanaTransaction({
      to: '11111111111111111111111111111112',
      amount: 1000n,
      fromAddress: '11111111111111111111111111111111',
    });

    expect(result.unsignedTransaction).toBeDefined();
    const txBytes = Buffer.from(result.unsignedTransaction, 'base64');
    expect(txBytes[0]).toBe(1); // 1 signature slot
    expect(txBytes.subarray(1, 65).every((b) => b === 0)).toBe(true); // empty signature
  });
});

// ============= sendTokens via Privy =============

describe('sendTokens via Privy', () => {
  let originalEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = { ...process.env };
    process.env.PRIVY_APP_ID = 'test-app-id';
    process.env.PRIVY_APP_SECRET = 'test-secret';

    vi.spyOn(wallet, 'getWalletConfig').mockReturnValue({
      defaultWallet: 'pv',
      passwordHash: null,
    });
    vi.spyOn(wallet, 'showWallet').mockReturnValue({
      name: 'pv',
      provider: 'privy',
      evm: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
      solana: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      privyWalletIds: { evm: 'wl_evm_1', solana: 'wl_sol_1' },
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  test('sends native ETH via Privy sendTransaction', async () => {
    fetch.mockImplementation(async (url) => {
      // Privy sendTransaction
      if (url.includes('privy.io')) {
        return {
          ok: true,
          json: () => Promise.resolve({ data: { hash: '0xTxHash123', caip2: 'eip155:8453' } }),
        };
      }
      // EVM RPC for confirmation
      return {
        json: () => Promise.resolve({
          result: { status: '0x1', blockNumber: '0x100' },
        }),
      };
    });

    const result = await sendTokens({
      to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
      amount: '0.01',
      chain: 'base',
      wallet: 'pv',
    });

    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('0xTxHash123');
    expect(result.chain).toBe('base');
  });

  test('sends native ETH via Privy dry run', async () => {
    const result = await sendTokens({
      to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
      amount: '0.01',
      chain: 'base',
      wallet: 'pv',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.from).toBe('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    expect(result.chain).toBe('base');
  });

  test('sends max native ETH via Privy with computed balance', async () => {
    let privyBody;
    fetch.mockImplementation(async (url, opts) => {
      const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : null;
      // RPC: eth_getBalance
      if (body?.method === 'eth_getBalance') {
        return { json: () => Promise.resolve({ jsonrpc: '2.0', id: body.id, result: '0xDE0B6B3A7640000' }) }; // 1 ETH
      }
      // RPC: eth_gasPrice
      if (body?.method === 'eth_gasPrice') {
        return { json: () => Promise.resolve({ jsonrpc: '2.0', id: body.id, result: '0x3B9ACA00' }) }; // 1 gwei
      }
      // Privy sendTransaction
      if (url?.includes('privy.io')) {
        privyBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: () => Promise.resolve({ data: { hash: '0xMaxTxHash', caip2: 'eip155:8453' } }),
        };
      }
      // RPC: eth_getTransactionReceipt (confirmation)
      if (body?.method === 'eth_getTransactionReceipt') {
        return { json: () => Promise.resolve({ result: { status: '0x1', blockNumber: '0x100' } }) };
      }
      return { json: () => Promise.resolve({ result: '0x0' }) };
    });

    const result = await sendTokens({
      to: '0x1234567890123456789012345678901234567890',
      amount: '0', // ignored when max=true
      chain: 'base',
      wallet: 'pv',
      max: true,
    });

    expect(result.transactionHash).toBe('0xMaxTxHash');
    // Value should be defined and less than 1 ETH (gas reserved)
    const txValue = privyBody.params.transaction.value;
    expect(txValue).toBeDefined();
    expect(BigInt(txValue)).toBeGreaterThan(0n);
    expect(BigInt(txValue)).toBeLessThan(BigInt('0xDE0B6B3A7640000'));
  });

  test('throws for missing Privy EVM wallet', async () => {
    vi.spyOn(wallet, 'showWallet').mockReturnValue({
      name: 'pv',
      provider: 'privy',
      evm: null,
      solana: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      privyWalletIds: { evm: undefined, solana: 'wl_sol_1' },
    });

    await expect(sendTokens({
      to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4',
      amount: '0.01',
      chain: 'base',
      wallet: 'pv',
    })).rejects.toThrow('No EVM wallet');
  });

  test('sends native SOL via Privy sign + broadcast', async () => {
    let signCallBody;
    fetch.mockImplementation(async (url, opts) => {
      const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : null;
      // Solana RPC: getBalance
      if (body?.method === 'getBalance') {
        return { json: () => Promise.resolve({ jsonrpc: '2.0', id: body.id, result: { value: 1000000000, context: { slot: 1 } } }) };
      }
      // Solana RPC: getLatestBlockhash
      if (body?.method === 'getLatestBlockhash') {
        return {
          json: () => Promise.resolve({
            jsonrpc: '2.0', id: body.id,
            result: { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 }, context: { slot: 1 } },
          }),
        };
      }
      // Privy signSolanaTransaction
      if (url?.includes('privy.io')) {
        signCallBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: () => Promise.resolve({ data: { signed_transaction: 'c2lnbmVkdHg=' } }),
        };
      }
      // Solana RPC: sendTransaction
      if (body?.method === 'sendTransaction') {
        return { json: () => Promise.resolve({ jsonrpc: '2.0', id: body.id, result: 'SolTxHash123' }) };
      }
      // Solana RPC: getSignatureStatuses
      if (body?.method === 'getSignatureStatuses') {
        return {
          json: () => Promise.resolve({
            jsonrpc: '2.0', id: body.id,
            result: { value: [{ confirmationStatus: 'confirmed', err: null }], context: { slot: 1 } },
          }),
        };
      }
      return { json: () => Promise.resolve({ jsonrpc: '2.0', id: body?.id, result: null }) };
    });

    const result = await sendTokens({
      to: '11111111111111111111111111111112',
      amount: '0.001',
      chain: 'solana',
      wallet: 'pv',
    });

    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('SolTxHash123');
    expect(result.chain).toBe('solana');
    expect(signCallBody.method).toBe('signTransaction');
    expect(signCallBody.params.encoding).toBe('base64');
  });

  test('sends max SPL token via Privy Solana (fetches token balance)', async () => {
    const TOKEN_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

    fetch.mockImplementation(async (url, opts) => {
      const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : null;
      // getAccountInfo (getTokenInfo)
      if (body?.method === 'getAccountInfo' && body.params?.[0] === TOKEN_MINT) {
        return {
          json: () => Promise.resolve({
            jsonrpc: '2.0', id: body.id,
            result: {
              value: {
                owner: TOKEN_PROGRAM,
                data: { parsed: { info: { decimals: 6 } } },
              },
              context: { slot: 1 },
            },
          }),
        };
      }
      // getTokenAccountBalance (max SPL balance query)
      if (body?.method === 'getTokenAccountBalance') {
        return {
          json: () => Promise.resolve({
            jsonrpc: '2.0', id: body.id,
            result: { value: { amount: '5000000', uiAmountString: '5.0' }, context: { slot: 1 } },
          }),
        };
      }
      // getLatestBlockhash
      if (body?.method === 'getLatestBlockhash') {
        return {
          json: () => Promise.resolve({
            jsonrpc: '2.0', id: body.id,
            result: { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 }, context: { slot: 1 } },
          }),
        };
      }
      // getBalance
      if (body?.method === 'getBalance') {
        return { json: () => Promise.resolve({ jsonrpc: '2.0', id: body.id, result: { value: 1000000000, context: { slot: 1 } } }) };
      }
      // Privy signSolanaTransaction
      if (url?.includes('privy.io')) {
        return {
          ok: true,
          json: () => Promise.resolve({ data: { signed_transaction: 'c2lnbmVkdHg=' } }),
        };
      }
      // sendTransaction
      if (body?.method === 'sendTransaction') {
        return { json: () => Promise.resolve({ jsonrpc: '2.0', id: body.id, result: 'SplTxHash123' }) };
      }
      // getSignatureStatuses
      if (body?.method === 'getSignatureStatuses') {
        return {
          json: () => Promise.resolve({
            jsonrpc: '2.0', id: body.id,
            result: { value: [{ confirmationStatus: 'confirmed', err: null }], context: { slot: 1 } },
          }),
        };
      }
      return { json: () => Promise.resolve({ jsonrpc: '2.0', id: body?.id, result: null }) };
    });

    const result = await sendTokens({
      to: '11111111111111111111111111111112',
      amount: '0',
      chain: 'solana',
      wallet: 'pv',
      token: TOKEN_MINT,
      max: true,
    });

    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe('SplTxHash123');
    // The amount returned should be the full token balance, not '0'
    expect(result.amount).toBe('5.0');
  });

  test('sends SOL via Privy dry run without making RPC calls', async () => {
    fetch.mockImplementation(async () => {
      throw new Error('No RPC calls should be made during Solana Privy dry run');
    });

    const result = await sendTokens({
      to: '11111111111111111111111111111112',
      amount: '0.001',
      chain: 'solana',
      wallet: 'pv',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.from).toBe('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    expect(result.chain).toBe('solana');
    expect(fetch).not.toHaveBeenCalled();
  });
});
