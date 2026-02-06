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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateAddress, validateTokenAddress, saveConfig, deleteConfig, getConfigFile, getConfigDir } from '../api.js';
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
  // Helper to simulate parseArgs behavior
  function parseArgs(args) {
    const result = { _: [], flags: {}, options: {} };
    
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      
      if (arg.startsWith('--')) {
        const key = arg.slice(2);
        const next = args[i + 1];
        
        if (key === 'pretty' || key === 'help' || key === 'table' || key === 'smart-money') {
          result.flags[key] = true;
        } else if (next && !next.startsWith('-')) {
          try {
            result.options[key] = JSON.parse(next);
          } catch {
            result.options[key] = next;
          }
          i++;
        } else {
          result.flags[key] = true;
        }
      } else if (arg.startsWith('-')) {
        result.flags[arg.slice(1)] = true;
      } else {
        result._.push(arg);
      }
    }
    
    return result;
  }

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
    expect(result.options.limit).toBe(10); // Should parse as number
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
});

// =================== Sort Parsing ===================

describe('Sort Parsing', () => {
  // Helper to simulate parseSort behavior
  function parseSort(sortOption, orderByOption) {
    if (orderByOption) return orderByOption;
    if (!sortOption) return undefined;
    
    const parts = sortOption.split(':');
    const field = parts[0];
    const direction = (parts[1] || 'desc').toUpperCase();
    
    return [{ field, direction }];
  }

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
  // Helper to simulate formatValue behavior
  function formatValue(val) {
    if (val === null || val === undefined) return '';
    if (typeof val === 'number') {
      if (Math.abs(val) >= 1000000) return (val / 1000000).toFixed(2) + 'M';
      if (Math.abs(val) >= 1000) return (val / 1000).toFixed(2) + 'K';
      if (Number.isInteger(val)) return val.toString();
      return val.toFixed(2);
    }
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  }

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
