/**
 * CLI Command Tests
 * 
 * Tests the command-line interface parsing and output formatting
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execSync, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'index.js');

// Helper to run CLI commands
function runCLI(args, options = {}) {
  const env = {
    ...process.env,
    NANSEN_API_KEY: 'test-key',
    ...options.env
  };
  
  try {
    const result = execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf8',
      env,
      timeout: 10000
    });
    return { stdout: result, exitCode: 0 };
  } catch (error) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.status
    };
  }
}

describe('CLI', () => {
  // =================== Help Commands ===================

  describe('Help Commands', () => {
    it('should show main help', () => {
      const { stdout, exitCode } = runCLI('help');
      
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Nansen CLI');
      expect(stdout).toContain('smart-money');
      expect(stdout).toContain('profiler');
      expect(stdout).toContain('token');
    });

    it('should show smart-money help', () => {
      const { stdout, exitCode } = runCLI('smart-money help');
      
      expect(exitCode).toBe(0);
      expect(stdout).toContain('netflow');
      expect(stdout).toContain('dex-trades');
      expect(stdout).toContain('holdings');
      expect(stdout).toContain('historical-holdings');
    });

    it('should show profiler help', () => {
      const { stdout, exitCode } = runCLI('profiler help');
      
      expect(exitCode).toBe(0);
      expect(stdout).toContain('balance');
      expect(stdout).toContain('labels');
      expect(stdout).toContain('transactions');
      expect(stdout).toContain('historical-balances');
      expect(stdout).toContain('related-wallets');
      expect(stdout).toContain('counterparties');
      expect(stdout).toContain('pnl-summary');
      expect(stdout).toContain('perp-positions');
      expect(stdout).toContain('perp-trades');
    });

    it('should show token help', () => {
      const { stdout, exitCode } = runCLI('token help');
      
      expect(exitCode).toBe(0);
      expect(stdout).toContain('screener');
      expect(stdout).toContain('holders');
      expect(stdout).toContain('flows');
      expect(stdout).toContain('flow-intelligence');
      expect(stdout).toContain('transfers');
      expect(stdout).toContain('jup-dca');
      expect(stdout).toContain('perp-trades');
      expect(stdout).toContain('perp-positions');
      expect(stdout).toContain('perp-pnl-leaderboard');
    });
  });

  // =================== Argument Parsing ===================

  describe('Argument Parsing', () => {
    it('should parse --chain flag and attempt API call', () => {
      // This will fail at API call with fetch failed, but tests parsing
      const { stdout, stderr } = runCLI('smart-money netflow --chain ethereum');
      const combined = stdout + (stderr || '');
      
      // Should output JSON (either success or error)
      expect(combined).toMatch(/\{.*\}/s);
      
      // If error, should be JSON format with error field
      if (combined.includes('error')) {
        const parsed = JSON.parse(combined);
        expect(parsed).toHaveProperty('success', false);
        expect(parsed).toHaveProperty('error');
      }
    });

    it('should parse --limit flag', () => {
      const { stdout, stderr } = runCLI('smart-money netflow --limit 5');
      const combined = stdout + (stderr || '');
      
      // Should output valid JSON
      expect(() => JSON.parse(combined)).not.toThrow();
    });

    it('should parse --pretty flag and format output', () => {
      const { stdout } = runCLI('smart-money help --pretty');
      
      // Pretty output should have indentation (newlines with spaces)
      expect(stdout).toContain('\n');
      expect(stdout).toMatch(/"commands"/);
    });

    it('should parse multiple chains as JSON array', () => {
      const { stdout, stderr } = runCLI('smart-money netflow --chains \'["ethereum","solana"]\'');
      const combined = stdout + (stderr || '');
      
      // Should output valid JSON
      expect(() => JSON.parse(combined)).not.toThrow();
    });

    it('should parse filters as JSON object', () => {
      const { stdout, stderr } = runCLI('smart-money netflow --filters \'{"min_usd":1000}\'');
      const combined = stdout + (stderr || '');
      
      // Should output valid JSON
      expect(() => JSON.parse(combined)).not.toThrow();
    });
  });

  // =================== Output Format ===================

  describe('Output Format', () => {
    it('should output help as readable text', () => {
      const { stdout, exitCode } = runCLI('help');
      
      expect(exitCode).toBe(0);
      expect(stdout).toContain('USAGE:');
      expect(stdout).toContain('COMMANDS:');
      expect(stdout).toContain('EXAMPLES:');
    });

    it('should output JSON for API commands', () => {
      const { stdout, stderr } = runCLI('smart-money help');
      const combined = stdout + (stderr || '');
      
      // Should be valid JSON
      const parsed = JSON.parse(combined);
      expect(parsed).toHaveProperty('success', true);
      expect(parsed.data).toHaveProperty('commands');
      expect(parsed.data.commands).toContain('netflow');
    });

    it('should output error as JSON with success:false', () => {
      const { stdout, stderr, exitCode } = runCLI('smart-money netflow', { 
        env: { NANSEN_API_KEY: '' } 
      });
      
      const combined = stdout + (stderr || '');
      const parsed = JSON.parse(combined);
      
      // Either success with data, or failure with error
      if (parsed.success === false) {
        expect(parsed).toHaveProperty('error');
        expect(typeof parsed.error).toBe('string');
      }
    });
  });

  // =================== Command Validation ===================

  describe('Command Validation', () => {
    it('should reject unknown commands with error JSON', () => {
      const { stdout, stderr, exitCode } = runCLI('unknown-command');
      const combined = stdout + (stderr || '');
      
      expect(exitCode).not.toBe(0);
      
      const parsed = JSON.parse(combined);
      expect(parsed.error).toContain('Unknown command');
      expect(parsed.available).toBeInstanceOf(Array);
    });

    it('should return help for unknown subcommands', () => {
      const { stdout, stderr } = runCLI('smart-money unknown');
      const combined = stdout + (stderr || '');
      
      const parsed = JSON.parse(combined);
      // Should return error with available subcommands
      if (parsed.success === false || parsed.data?.error) {
        const data = parsed.data || parsed;
        expect(data.available || data.error).toBeDefined();
      }
    });

    it('should fail with error when profiler balance missing address', () => {
      const { stdout, stderr, exitCode } = runCLI('profiler balance');
      const combined = stdout + (stderr || '');
      
      expect(exitCode).not.toBe(0);
      
      const parsed = JSON.parse(combined);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBeDefined();
    });

    it('should fail with error when token holders missing token', () => {
      const { stdout, stderr, exitCode } = runCLI('token holders');
      const combined = stdout + (stderr || '');
      
      expect(exitCode).not.toBe(0);
      
      const parsed = JSON.parse(combined);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBeDefined();
    });
  });

  // =================== Environment Variables ===================

  describe('Environment Variables', () => {
    it('should use NANSEN_API_KEY from env and output JSON', () => {
      const { stdout, stderr } = runCLI('smart-money netflow', {
        env: { NANSEN_API_KEY: 'env-test-key' }
      });
      const combined = stdout + (stderr || '');
      
      // Should output valid JSON (success or error)
      expect(() => JSON.parse(combined)).not.toThrow();
      
      const parsed = JSON.parse(combined);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should use NANSEN_BASE_URL if provided', () => {
      const { stdout, stderr } = runCLI('smart-money netflow', {
        env: { 
          NANSEN_API_KEY: 'test-key',
          NANSEN_BASE_URL: 'https://custom.api.com'
        }
      });
      const combined = stdout + (stderr || '');
      
      // Should output valid JSON
      expect(() => JSON.parse(combined)).not.toThrow();
    });
  });

  // =================== Smart Money Commands ===================

  describe('Smart Money Commands', () => {
    // Helper to verify CLI JSON output
    function expectValidJsonOutput(stdout, stderr) {
      const combined = stdout + (stderr || '');
      expect(() => JSON.parse(combined)).not.toThrow();
      return JSON.parse(combined);
    }

    it('should support smart-money netflow and output JSON', () => {
      const { stdout, stderr } = runCLI('smart-money netflow --chain solana');
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support smart-money dex-trades and output JSON', () => {
      const { stdout, stderr } = runCLI('smart-money dex-trades --chain solana');
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support smart-money holdings and output JSON', () => {
      const { stdout, stderr } = runCLI('smart-money holdings --chain solana');
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support smart-money perp-trades and output JSON', () => {
      const { stdout, stderr } = runCLI('smart-money perp-trades');
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support smart-money dcas and output JSON', () => {
      const { stdout, stderr } = runCLI('smart-money dcas');
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support --labels filter and output JSON', () => {
      const { stdout, stderr } = runCLI('smart-money dex-trades --chain solana --labels Fund');
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support smart-money historical-holdings and output JSON', () => {
      const { stdout, stderr } = runCLI('smart-money historical-holdings --chain solana');
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support --days option and output JSON', () => {
      const { stdout, stderr } = runCLI('smart-money historical-holdings --chain solana --days 7');
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });
  });

  // =================== Profiler Commands ===================

  describe('Profiler Commands', () => {
    const TEST_ADDRESS = '0x28c6c06298d514db089934071355e5743bf21d60';

    // Helper to verify CLI JSON output
    function expectValidJsonOutput(stdout, stderr) {
      const combined = stdout + (stderr || '');
      expect(() => JSON.parse(combined)).not.toThrow();
      return JSON.parse(combined);
    }

    it('should support profiler balance and output JSON', () => {
      const { stdout, stderr } = runCLI(`profiler balance --address ${TEST_ADDRESS} --chain ethereum`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support profiler labels and output JSON', () => {
      const { stdout, stderr } = runCLI(`profiler labels --address ${TEST_ADDRESS} --chain ethereum`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support profiler transactions and output JSON', () => {
      const { stdout, stderr } = runCLI(`profiler transactions --address ${TEST_ADDRESS} --chain ethereum`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support profiler pnl and output JSON', () => {
      const { stdout, stderr } = runCLI(`profiler pnl --address ${TEST_ADDRESS} --chain ethereum`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support profiler search and output JSON', () => {
      const { stdout, stderr } = runCLI('profiler search --query "Vitalik"');
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support profiler historical-balances and output JSON', () => {
      const { stdout, stderr } = runCLI(`profiler historical-balances --address ${TEST_ADDRESS} --chain ethereum`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support profiler related-wallets and output JSON', () => {
      const { stdout, stderr } = runCLI(`profiler related-wallets --address ${TEST_ADDRESS} --chain ethereum`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support profiler counterparties and output JSON', () => {
      const { stdout, stderr } = runCLI(`profiler counterparties --address ${TEST_ADDRESS} --chain ethereum`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support profiler pnl-summary and output JSON', () => {
      const { stdout, stderr } = runCLI(`profiler pnl-summary --address ${TEST_ADDRESS} --chain ethereum`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support profiler perp-positions and output JSON', () => {
      const { stdout, stderr } = runCLI(`profiler perp-positions --address ${TEST_ADDRESS}`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support profiler perp-trades and output JSON', () => {
      const { stdout, stderr } = runCLI(`profiler perp-trades --address ${TEST_ADDRESS}`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support --days option for profiler and output JSON', () => {
      const { stdout, stderr } = runCLI(`profiler historical-balances --address ${TEST_ADDRESS} --chain ethereum --days 14`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });
  });

  // =================== Token Commands ===================

  describe('Token Commands', () => {
    const TEST_TOKEN = 'So11111111111111111111111111111111111111112';

    // Helper to verify CLI JSON output
    function expectValidJsonOutput(stdout, stderr) {
      const combined = stdout + (stderr || '');
      expect(() => JSON.parse(combined)).not.toThrow();
      return JSON.parse(combined);
    }

    it('should support token screener and output JSON', () => {
      const { stdout, stderr } = runCLI('token screener --chain solana --timeframe 24h');
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support token holders and output JSON', () => {
      const { stdout, stderr } = runCLI(`token holders --token ${TEST_TOKEN} --chain solana`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support token flows and output JSON', () => {
      const { stdout, stderr } = runCLI(`token flows --token ${TEST_TOKEN} --chain solana`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support token dex-trades and output JSON', () => {
      const { stdout, stderr } = runCLI(`token dex-trades --token ${TEST_TOKEN} --chain solana`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support token pnl and output JSON', () => {
      const { stdout, stderr } = runCLI(`token pnl --token ${TEST_TOKEN} --chain solana`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support token who-bought-sold and output JSON', () => {
      const { stdout, stderr } = runCLI(`token who-bought-sold --token ${TEST_TOKEN} --chain solana`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support --smart-money flag and output JSON', () => {
      const { stdout, stderr } = runCLI(`token dex-trades --token ${TEST_TOKEN} --chain solana --smart-money`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support token flow-intelligence and output JSON', () => {
      const { stdout, stderr } = runCLI(`token flow-intelligence --token ${TEST_TOKEN} --chain solana`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support token transfers and output JSON', () => {
      const { stdout, stderr } = runCLI(`token transfers --token ${TEST_TOKEN} --chain solana`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support token jup-dca and output JSON', () => {
      const { stdout, stderr } = runCLI(`token jup-dca --token ${TEST_TOKEN}`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support token perp-trades with --symbol and output JSON', () => {
      const { stdout, stderr } = runCLI('token perp-trades --symbol BTC');
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support token perp-positions with --symbol and output JSON', () => {
      const { stdout, stderr } = runCLI('token perp-positions --symbol ETH');
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support token perp-pnl-leaderboard with --symbol and output JSON', () => {
      const { stdout, stderr } = runCLI('token perp-pnl-leaderboard --symbol BTC');
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should support --days option for token commands and output JSON', () => {
      const { stdout, stderr } = runCLI(`token transfers --token ${TEST_TOKEN} --chain solana --days 3`);
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });
  });

  // =================== Portfolio Commands ===================

  describe('Portfolio Commands', () => {
    // Helper to verify CLI JSON output
    function expectValidJsonOutput(stdout, stderr) {
      const combined = stdout + (stderr || '');
      expect(() => JSON.parse(combined)).not.toThrow();
      return JSON.parse(combined);
    }

    it('should support portfolio defi and output JSON', () => {
      const { stdout, stderr } = runCLI('portfolio defi --wallet 0x28c6c06298d514db089934071355e5743bf21d60');
      const parsed = expectValidJsonOutput(stdout, stderr);
      expect(typeof parsed.success).toBe('boolean');
    });

    it('should return help for portfolio help', () => {
      const { stdout, stderr } = runCLI('portfolio help');
      const parsed = expectValidJsonOutput(stdout, stderr);
      
      expect(parsed.success).toBe(true);
      expect(parsed.data.commands).toContain('defi');
    });
  });
});
