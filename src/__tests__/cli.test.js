/**
 * CLI Smoke Tests
 * 
 * Minimal end-to-end tests that verify the CLI binary works.
 * Detailed logic tests are in cli.internal.test.js (with coverage).
 * 
 * These tests spawn subprocesses so they're slower and don't contribute
 * to coverage metrics, but they verify the real CLI works.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'index.js');

// Create a mock walletconnect binary that reports "not connected"
const MOCK_BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-test-'));
const MOCK_WC_PATH = path.join(MOCK_BIN_DIR, 'walletconnect');
fs.writeFileSync(MOCK_WC_PATH, '#!/bin/sh\necho \'{"connected":false}\'\n');
fs.chmodSync(MOCK_WC_PATH, 0o755);

// Helper to run CLI commands
function runCLI(args, options = {}) {
  const env = {
    ...process.env,
    PATH: `${MOCK_BIN_DIR}:${process.env.PATH}`,
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

describe('CLI Smoke Tests', () => {
  afterAll(() => {
    fs.rmSync(MOCK_BIN_DIR, { recursive: true, force: true });
  });

  // =================== Help & Basic Commands ===================

  it('should show help', () => {
    const { stdout, exitCode } = runCLI('help');

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Nansen CLI');
    expect(stdout).toContain('research');
    expect(stdout).toContain('trade');
    expect(stdout).toContain('wallet');
  });

  it('should show schema', () => {
    const { stdout, exitCode } = runCLI('schema');
    
    expect(exitCode).toBe(0);
    const schema = JSON.parse(stdout);
    expect(schema.version).toBeDefined();
    expect(schema.commands).toBeDefined();
  });

  // =================== JSON Output Format ===================

  it('should output valid JSON on error', () => {
    const { stdout, stderr, exitCode: _exitCode } = runCLI('smart-money netflow', {
      env: { NANSEN_API_KEY: 'invalid-key' }
    });

    // Should fail with network error but still output valid JSON (error goes to stderr)
    // Parse first JSON line only (stderr may contain update notifications)
    const output = stdout || stderr;
    const firstLine = output.split('\n').find(l => l.startsWith('{'));
    const result = JSON.parse(firstLine);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.code).toBeDefined();
  });

  it('should support --pretty flag', () => {
    const { stdout, exitCode } = runCLI('schema --pretty');
    
    expect(exitCode).toBe(0);
    expect(stdout).toContain('\n'); // Pretty JSON has newlines
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  // =================== Command Routing ===================

  it('should route research smart-money commands', () => {
    const { stdout } = runCLI('research smart-money help');
    expect(stdout).toContain('netflow');
  });

  it('should route research profiler commands', () => {
    const { stdout } = runCLI('research profiler help');
    expect(stdout).toContain('balance');
  });

  it('should route research token commands', () => {
    const { stdout } = runCLI('research token help');
    expect(stdout).toContain('screener');
    expect(stdout).toContain('ohlcv');
    expect(stdout).toContain('top-tokens');
  });

  it('should route research prediction-market commands', () => {
    const { stdout } = runCLI('research pm help');
    expect(stdout).toContain('ohlcv');
    expect(stdout).toContain('market-screener');
    expect(stdout).toContain('categories');
    expect(stdout).toContain('address-summary');
  });

  it('should route top-level pm alias to prediction-market', () => {
    const { stdout } = runCLI('pm help');
    expect(stdout).toContain('ohlcv');
    expect(stdout).toContain('market-screener');
    expect(stdout).toContain('categories');
    expect(stdout).toContain('address-summary');
  });

  it('should error on pm ohlcv without --market-id', () => {
    const { stdout, stderr, exitCode } = runCLI('research pm ohlcv');
    expect(exitCode).not.toBe(0);
    const output = stdout || stderr;
    const json = JSON.parse(output.split('\n').find(l => l.startsWith('{')));
    expect(json.code).toBe('MISSING_PARAM');
  });

  it('should error on pm trades-by-address without --address', () => {
    const { stdout, stderr, exitCode } = runCLI('research pm trades-by-address');
    expect(exitCode).not.toBe(0);
    const output = stdout || stderr;
    const json = JSON.parse(output.split('\n').find(l => l.startsWith('{')));
    expect(json.code).toBe('MISSING_PARAM');
  });

  it('should error on pm trades-by-address with invalid address', () => {
    const { stdout, stderr, exitCode } = runCLI('research pm trades-by-address --address notanaddress');
    expect(exitCode).not.toBe(0);
    const output = stdout || stderr;
    const json = JSON.parse(output.split('\n').find(l => l.startsWith('{')));
    expect(json.code).toBe('INVALID_ADDRESS');
  });

  it('should error on pm address-summary without --address', () => {
    const { stdout, stderr, exitCode } = runCLI('research pm address-summary');
    expect(exitCode).not.toBe(0);
    const output = stdout || stderr;
    const json = JSON.parse(output.split('\n').find(l => l.startsWith('{')));
    expect(json.code).toBe('MISSING_PARAM');
  });

  it('should error on pm address-summary with invalid address', () => {
    const { stdout, stderr, exitCode } = runCLI('research pm address-summary --address notanaddress');
    expect(exitCode).not.toBe(0);
    const output = stdout || stderr;
    const json = JSON.parse(output.split('\n').find(l => l.startsWith('{')));
    expect(json.code).toBe('INVALID_ADDRESS');
  });

  it('should list available subcommands for unknown pm subcommand', () => {
    const { stdout, stderr, exitCode } = runCLI('research pm nonexistent');
    expect(exitCode).not.toBe(0);
    const output = stdout || stderr;
    const json = JSON.parse(output.split('\n').find(l => l.startsWith('{')));
    expect(json.success).toBe(false);
    expect(json.error).toContain('Unknown subcommand');
    expect(json.error).toContain('ohlcv');
    expect(json.code).toBe('UNKNOWN');
  });

  it('should still route deprecated smart-money path', () => {
    const { stdout } = runCLI('smart-money help');
    expect(stdout).toContain('netflow');
  });

  // =================== Environment Variables ===================

  it('should use NANSEN_API_KEY from environment', () => {
    const { stdout, stderr } = runCLI('smart-money netflow', {
      env: { NANSEN_API_KEY: 'test-env-key' }
    });
    
    // Will fail auth but proves env var is being read (error goes to stderr)
    // Parse first JSON line only (stderr may contain update notifications)
    const output = stdout || stderr;
    const firstLine = output.split('\n').find(l => l.startsWith('{'));
    const result = JSON.parse(firstLine);
    expect(result.success).toBe(false);
    expect(['UNAUTHORIZED', 'PAYMENT_REQUIRED', 'UNKNOWN']).toContain(result.code);
  });

  // =================== Error Handling ===================

  it('should handle unknown command gracefully', () => {
    const { stdout, exitCode } = runCLI('unknown-command');
    
    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.error).toContain('Unknown command');
  });

  it('should handle unknown subcommand gracefully', () => {
    const { stdout } = runCLI('smart-money unknown-subcommand');
    
    const result = JSON.parse(stdout);
    expect(result.data.error).toContain('Unknown subcommand');
  });
});
