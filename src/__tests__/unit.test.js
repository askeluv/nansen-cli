/**
 * Unit Tests for Core Logic
 * 
 * Tests for:
 * - Address validation
 * - Config management
 * - Date range generation
 * - CLI parsing
 * - Table formatting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateAddress, validateTokenAddress, getConfigFile, getConfigDir, ErrorCode, NansenError } from '../api.js';
import { parseArgs, parseSort, formatValue } from '../cli.js';
import { selectPaymentRequirement, buildEIP712TypedData, buildPaymentSignatureHeader } from '../walletconnect-x402.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// =================== Address Validation ===================

describe('Address Validation', () => {
  describe('EVM Addresses', () => {
    const EVM_CHAINS = ['ethereum', 'arbitrum', 'base', 'bnb', 'polygon', 'optimism', 'avalanche'];

    it('should accept valid EVM addresses', () => {
      const validAddresses = [
        '0x28c6c06298d514db089934071355e5743bf21d60',
        '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        '0x0000000000000000000000000000000000000000',
        '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
      ];

      for (const chain of EVM_CHAINS) {
        for (const address of validAddresses) {
          const result = validateAddress(address, chain);
          expect(result.valid).toBe(true);
          expect(result.error).toBeUndefined();
        }
      }
    });

    it('should reject EVM addresses without 0x prefix', () => {
      const result = validateAddress('28c6c06298d514db089934071355e5743bf21d60', 'ethereum');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid EVM address');
    });

    it('should reject EVM addresses with wrong length', () => {
      const shortAddress = '0x28c6c06298d514db089934071355e5743bf21d6'; // 39 chars
      const longAddress = '0x28c6c06298d514db089934071355e5743bf21d600'; // 41 chars

      expect(validateAddress(shortAddress, 'ethereum').valid).toBe(false);
      expect(validateAddress(longAddress, 'ethereum').valid).toBe(false);
    });

    it('should reject EVM addresses with invalid characters', () => {
      const result = validateAddress('0x28c6c06298d514db089934071355e5743bf21dGG', 'ethereum');
      expect(result.valid).toBe(false);
    });

    it('should reject empty or null addresses', () => {
      expect(validateAddress('', 'ethereum').valid).toBe(false);
      expect(validateAddress(null, 'ethereum').valid).toBe(false);
      expect(validateAddress(undefined, 'ethereum').valid).toBe(false);
    });

    it('should trim whitespace from addresses', () => {
      const result = validateAddress('  0x28c6c06298d514db089934071355e5743bf21d60  ', 'ethereum');
      expect(result.valid).toBe(true);
    });
  });

  describe('Solana Addresses', () => {
    it('should accept valid Solana addresses', () => {
      const validAddresses = [
        'Gu29tjXrVr9v5n42sX1DNrMiF3BwbrTm379szgB9qXjc',
        'So11111111111111111111111111111111111111112',
        '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      ];

      for (const address of validAddresses) {
        const result = validateAddress(address, 'solana');
        expect(result.valid).toBe(true);
      }
    });

    it('should reject Solana addresses that are too short', () => {
      const result = validateAddress('abc123', 'solana');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid Solana address');
    });

    it('should reject Solana addresses with invalid Base58 characters', () => {
      // 0, O, I, l are not valid Base58 characters
      const result = validateAddress('0o1lIGu29tjXrVr9v5n42sX1DNrMiF3BwbrTm379szg', 'solana');
      expect(result.valid).toBe(false);
    });
  });

  describe('Token Address Validation', () => {
    it('should use same rules as wallet validation', () => {
      const solanaToken = 'So11111111111111111111111111111111111111112';
      const ethToken = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

      expect(validateTokenAddress(solanaToken, 'solana').valid).toBe(true);
      expect(validateTokenAddress(ethToken, 'ethereum').valid).toBe(true);
    });

    it('should default to solana chain', () => {
      const solanaToken = 'So11111111111111111111111111111111111111112';
      const result = validateTokenAddress(solanaToken);
      expect(result.valid).toBe(true);
    });
  });

  describe('Unknown Chains', () => {
    it('should allow any non-empty string for unknown chains', () => {
      const result = validateAddress('any-address-format', 'unknown-chain');
      expect(result.valid).toBe(true);
    });
  });
});

// =================== Date Range Generation ===================

describe('Date Range Generation', () => {
  it('should generate correct date format (YYYY-MM-DD)', () => {
    const today = new Date();
    const expectedFormat = /^\d{4}-\d{2}-\d{2}$/;
    
    const dateStr = today.toISOString().split('T')[0];
    expect(dateStr).toMatch(expectedFormat);
  });

  it('should calculate correct day difference', () => {
    const days = 7;
    const now = Date.now();
    const to = new Date(now).toISOString().split('T')[0];
    const from = new Date(now - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const fromDate = new Date(from);
    const toDate = new Date(to);
    const diffMs = toDate - fromDate;
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    
    expect(diffDays).toBe(days);
  });

  it('should handle various day ranges correctly', () => {
    for (const days of [1, 7, 14, 30, 90, 365]) {
      const now = Date.now();
      const to = new Date(now).toISOString().split('T')[0];
      const from = new Date(now - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      const fromDate = new Date(from);
      const toDate = new Date(to);
      const diffDays = Math.round((toDate - fromDate) / (1000 * 60 * 60 * 24));
      
      expect(diffDays).toBe(days);
    }
  });
});

// =================== Config Management ===================

describe('Config Management', () => {
  const originalHome = process.env.HOME;
  let tempDir;

  beforeEach(() => {
    // Create temp directory for tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-test-'));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    // Restore and cleanup
    process.env.HOME = originalHome;
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should return correct config directory path', () => {
    const configDir = getConfigDir();
    expect(configDir).toContain('.nansen');
  });

  it('should return correct config file path', () => {
    const configFile = getConfigFile();
    expect(configFile).toContain('.nansen');
    expect(configFile).toContain('config.json');
  });
});

// =================== CLI Argument Parsing ===================

describe('CLI Argument Parsing', () => {
  // Now uses parseArgs imported from cli.js (no duplicate implementation)

  it('should parse positional arguments', () => {
    const result = parseArgs(['smart-money', 'netflow']);
    expect(result._).toEqual(['smart-money', 'netflow']);
  });

  it('should parse boolean flags', () => {
    const result = parseArgs(['--pretty', '--table']);
    expect(result.flags.pretty).toBe(true);
    expect(result.flags.table).toBe(true);
  });

  it('should parse key-value options', () => {
    const result = parseArgs(['--chain', 'ethereum', '--limit', '10']);
    expect(result.options.chain).toBe('ethereum');
    expect(result.options.limit).toBe('10'); // Kept as string to avoid scientific notation for large numbers
  });

  it('should parse JSON options', () => {
    const result = parseArgs(['--filters', '{"min_usd":1000}']);
    expect(result.options.filters).toEqual({ min_usd: 1000 });
  });

  it('should parse array JSON options', () => {
    const result = parseArgs(['--chains', '["ethereum","solana"]']);
    expect(result.options.chains).toEqual(['ethereum', 'solana']);
  });

  it('should handle mixed arguments', () => {
    const result = parseArgs([
      'token', 'screener',
      '--chain', 'solana',
      '--pretty',
      '--filters', '{"only_smart_money":true}'
    ]);
    
    expect(result._).toEqual(['token', 'screener']);
    expect(result.options.chain).toBe('solana');
    expect(result.flags.pretty).toBe(true);
    expect(result.options.filters).toEqual({ only_smart_money: true });
  });

  it('should keep string values that are not valid JSON', () => {
    const result = parseArgs(['--address', '0x123abc', '--query', 'Vitalik']);
    expect(result.options.address).toBe('0x123abc');
    expect(result.options.query).toBe('Vitalik');
  });

  it('should keep large numeric amounts as strings to avoid scientific notation', () => {
    // 1000 tokens with 18 decimals = 10^21, which JS converts to 1e+21
    const result = parseArgs(['--amount', '1000000000000000000000']);
    expect(result.options.amount).toBe('1000000000000000000000');
    // Verify String() preserves the full representation
    expect(String(result.options.amount)).toBe('1000000000000000000000');
  });

  it('should keep all numeric option values as strings', () => {
    const result = parseArgs(['--days', '30', '--limit', '100']);
    expect(result.options.days).toBe('30');
    expect(result.options.limit).toBe('100');
  });
});

// =================== Sort Parsing ===================

describe('Sort Parsing', () => {
  // Now uses parseSort imported from cli.js (no duplicate implementation)

  it('should parse simple sort field (defaults to DESC)', () => {
    const result = parseSort('value_usd');
    expect(result).toEqual([{ field: 'value_usd', direction: 'DESC' }]);
  });

  it('should parse sort field with direction', () => {
    const result = parseSort('timestamp:asc');
    expect(result).toEqual([{ field: 'timestamp', direction: 'ASC' }]);
  });

  it('should handle descending direction explicitly', () => {
    const result = parseSort('pnl_usd:desc');
    expect(result).toEqual([{ field: 'pnl_usd', direction: 'DESC' }]);
  });

  it('should prefer orderBy over sort', () => {
    const orderBy = [{ field: 'custom', direction: 'ASC' }];
    const result = parseSort('ignored', orderBy);
    expect(result).toEqual(orderBy);
  });

  it('should return undefined for no sort option', () => {
    const result = parseSort(undefined, undefined);
    expect(result).toBeUndefined();
  });
});

// =================== Table Formatting ===================

describe('Table Formatting', () => {
  // Now uses formatValue imported from cli.js (no duplicate implementation)

  it('should format large numbers with M suffix', () => {
    expect(formatValue(1000000)).toBe('1.00M');
    expect(formatValue(5500000)).toBe('5.50M');
    expect(formatValue(-2000000)).toBe('-2.00M');
  });

  it('should format medium numbers with K suffix', () => {
    expect(formatValue(1000)).toBe('1.00K');
    expect(formatValue(50000)).toBe('50.00K');
    expect(formatValue(-25000)).toBe('-25.00K');
  });

  it('should format small numbers normally', () => {
    expect(formatValue(100)).toBe('100');
    expect(formatValue(999)).toBe('999');
  });

  it('should format decimals to 2 places', () => {
    expect(formatValue(1.5)).toBe('1.50');
    expect(formatValue(0.123456)).toBe('0.12');
  });

  it('should handle null and undefined', () => {
    expect(formatValue(null)).toBe('');
    expect(formatValue(undefined)).toBe('');
  });

  it('should stringify objects', () => {
    expect(formatValue({ foo: 'bar' })).toBe('{"foo":"bar"}');
    expect(formatValue([1, 2, 3])).toBe('[1,2,3]');
  });

  it('should convert other types to string', () => {
    expect(formatValue('hello')).toBe('hello');
    expect(formatValue(true)).toBe('true');
  });
});

// =================== Error Messages ===================

describe('Error Messages', () => {
  it('should provide helpful error for invalid EVM address', () => {
    const result = validateAddress('invalid', 'ethereum');
    expect(result.error).toContain('0x');
    expect(result.error).toContain('40');
  });

  it('should provide helpful error for invalid Solana address', () => {
    const result = validateAddress('short', 'solana');
    expect(result.error).toContain('Base58');
    expect(result.error).toContain('32-44');
  });

  it('should provide helpful error for missing address', () => {
    const result = validateAddress('', 'ethereum');
    expect(result.error).toContain('required');
  });
});

// =================== Error Codes ===================

describe('Error Codes', () => {
  describe('ErrorCode enum', () => {
    it('should define all expected error codes', () => {
      expect(ErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED');
      expect(ErrorCode.FORBIDDEN).toBe('FORBIDDEN');
      expect(ErrorCode.RATE_LIMITED).toBe('RATE_LIMITED');
      expect(ErrorCode.INVALID_ADDRESS).toBe('INVALID_ADDRESS');
      expect(ErrorCode.INVALID_TOKEN).toBe('INVALID_TOKEN');
      expect(ErrorCode.INVALID_CHAIN).toBe('INVALID_CHAIN');
      expect(ErrorCode.INVALID_PARAMS).toBe('INVALID_PARAMS');
      expect(ErrorCode.MISSING_PARAM).toBe('MISSING_PARAM');
      expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');
      expect(ErrorCode.TOKEN_NOT_FOUND).toBe('TOKEN_NOT_FOUND');
      expect(ErrorCode.ADDRESS_NOT_FOUND).toBe('ADDRESS_NOT_FOUND');
      expect(ErrorCode.SERVER_ERROR).toBe('SERVER_ERROR');
      expect(ErrorCode.SERVICE_UNAVAILABLE).toBe('SERVICE_UNAVAILABLE');
      expect(ErrorCode.NETWORK_ERROR).toBe('NETWORK_ERROR');
      expect(ErrorCode.TIMEOUT).toBe('TIMEOUT');
      expect(ErrorCode.UNKNOWN).toBe('UNKNOWN');
    });
  });

  describe('NansenError class', () => {
    it('should create error with all properties', () => {
      const error = new NansenError('Test error', ErrorCode.INVALID_ADDRESS, 400, { field: 'address' });
      
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('INVALID_ADDRESS');
      expect(error.status).toBe(400);
      expect(error.details).toEqual({ field: 'address' });
      expect(error.name).toBe('NansenError');
    });

    it('should default to UNKNOWN error code', () => {
      const error = new NansenError('Unknown error');
      expect(error.code).toBe('UNKNOWN');
      expect(error.status).toBeNull();
      expect(error.details).toBeNull();
    });

    it('should serialize to JSON correctly', () => {
      const error = new NansenError('Test error', ErrorCode.RATE_LIMITED, 429, { retry_after: 60 });
      const json = error.toJSON();
      
      expect(json).toEqual({
        error: 'Test error',
        code: 'RATE_LIMITED',
        status: 429,
        details: { retry_after: 60 }
      });
    });
  });

  describe('Validation error codes', () => {
    it('should return INVALID_ADDRESS code for bad EVM address', () => {
      const result = validateAddress('invalid', 'ethereum');
      expect(result.valid).toBe(false);
      expect(result.code).toBe('INVALID_ADDRESS');
    });

    it('should return INVALID_ADDRESS code for bad Solana address', () => {
      const result = validateAddress('short', 'solana');
      expect(result.valid).toBe(false);
      expect(result.code).toBe('INVALID_ADDRESS');
    });

    it('should return MISSING_PARAM code for empty address', () => {
      const result = validateAddress('', 'ethereum');
      expect(result.valid).toBe(false);
      expect(result.code).toBe('MISSING_PARAM');
    });

    it('should return MISSING_PARAM code for null address', () => {
      const result = validateAddress(null, 'ethereum');
      expect(result.valid).toBe(false);
      expect(result.code).toBe('MISSING_PARAM');
    });

    it('should not include code for valid addresses', () => {
      const result = validateAddress('0x28c6c06298d514db089934071355e5743bf21d60', 'ethereum');
      expect(result.valid).toBe(true);
      expect(result.code).toBeUndefined();
    });
  });
});

// =================== x402 Payment ===================

describe('x402 Payment', () => {
  const MOCK_REQUIREMENT = {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '10000',
    payTo: '0xRecipient',
    maxTimeoutSeconds: 300,
    extra: {
      name: 'USD Coin',
      version: '2',
    },
  };

  describe('selectPaymentRequirement', () => {
    it('should select a requirement with scheme=exact and EIP-3009 support', () => {
      const result = selectPaymentRequirement([MOCK_REQUIREMENT]);
      expect(result).toEqual(MOCK_REQUIREMENT);
    });

    it('should return null for empty accepts array', () => {
      expect(selectPaymentRequirement([])).toBeNull();
    });

    it('should return null when no requirement has extra.name', () => {
      const noName = { ...MOCK_REQUIREMENT, extra: { version: '2' } };
      expect(selectPaymentRequirement([noName])).toBeNull();
    });

    it('should return null when scheme is not exact', () => {
      const wrongScheme = { ...MOCK_REQUIREMENT, scheme: 'streaming' };
      expect(selectPaymentRequirement([wrongScheme])).toBeNull();
    });

    it('should return null for null/undefined input', () => {
      expect(selectPaymentRequirement(null)).toBeNull();
      expect(selectPaymentRequirement(undefined)).toBeNull();
    });

    it('should pick the first compatible requirement from multiple', () => {
      const other = { scheme: 'streaming', extra: {} };
      const result = selectPaymentRequirement([other, MOCK_REQUIREMENT]);
      expect(result).toEqual(MOCK_REQUIREMENT);
    });
  });

  describe('buildEIP712TypedData', () => {
    it('should produce correct EIP-712 structure', () => {
      const typedData = buildEIP712TypedData({
        fromAddress: '0xSender',
        requirement: MOCK_REQUIREMENT,
      });

      expect(typedData.primaryType).toBe('TransferWithAuthorization');
      expect(typedData.domain.name).toBe('USD Coin');
      expect(typedData.domain.version).toBe('2');
      expect(typedData.domain.chainId).toBe(8453);
      expect(typedData.domain.verifyingContract).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
      expect(typedData.message.from).toBe('0xSender');
      expect(typedData.message.to).toBe('0xRecipient');
      expect(typedData.message.value).toBe('10000'); // from amount field
      expect(typedData.message.validAfter).toBeGreaterThan(0);
      expect(typedData.message.validBefore).toBeGreaterThan(typedData.message.validAfter);
      expect(typedData.message.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('should include all required EIP-712 types', () => {
      const typedData = buildEIP712TypedData({
        fromAddress: '0xSender',
        requirement: MOCK_REQUIREMENT,
      });

      expect(typedData.types.EIP712Domain).toBeDefined();
      expect(typedData.types.TransferWithAuthorization).toBeDefined();
      expect(typedData.types.TransferWithAuthorization).toHaveLength(6);
    });

    it('should generate unique nonces', () => {
      const td1 = buildEIP712TypedData({ fromAddress: '0xA', requirement: MOCK_REQUIREMENT });
      const td2 = buildEIP712TypedData({ fromAddress: '0xA', requirement: MOCK_REQUIREMENT });
      expect(td1.message.nonce).not.toBe(td2.message.nonce);
    });
  });

  describe('buildPaymentSignatureHeader', () => {
    it('should produce valid base64 JSON with x402Version and required fields', () => {
      const header = buildPaymentSignatureHeader({
        signature: '0xSig',
        authorization: { from: '0xA', to: '0xB', value: '100', validAfter: 0, validBefore: 999, nonce: '0x123' },
        resource: { url: 'https://api.example.com/test', description: 'Test', mimeType: '' },
        accepted: MOCK_REQUIREMENT,
      });

      const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
      expect(decoded.x402Version).toBe(2);
      expect(decoded.resource.url).toBe('https://api.example.com/test');
      expect(decoded.accepted.scheme).toBe('exact');
      expect(decoded.payload.signature).toBe('0xSig');
      expect(decoded.payload.authorization.from).toBe('0xA');
      expect(decoded.payload.authorization.to).toBe('0xB');
    });

    it('should preserve UTF-8 fields in accepted requirement metadata', () => {
      const accepted = {
        ...MOCK_REQUIREMENT,
        network: 'eip155:196',
        asset: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736',
        extra: {
          ...MOCK_REQUIREMENT.extra,
          name: 'USD₮0',
          symbol: 'USDT0',
        },
      };
      const header = buildPaymentSignatureHeader({
        signature: '0xSig',
        authorization: { from: '0xA', to: '0xB', value: '100', validAfter: 0, validBefore: 999, nonce: '0x123' },
        resource: { url: 'https://api.example.com/test', description: 'Test', mimeType: '' },
        accepted,
      });

      const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
      expect(decoded.accepted.extra.name).toBe('USD₮0');
      expect(decoded.accepted.asset).toBe('0x779Ded0c9e1022225f8E0630b35a9b54bE713736');
    });
  });
});
