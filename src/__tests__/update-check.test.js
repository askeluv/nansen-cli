/**
 * Update Check Tests
 *
 * Tests for:
 * - Semver comparison (isNewer via getUpdateNotification)
 * - Cache reading (getUpdateNotification)
 * - Env var suppression (NO_UPDATE_NOTIFIER, CI)
 * - Background check scheduling (scheduleUpdateCheck)
 * - CLI integration (notification on stderr)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import childProcess from 'child_process';

// We need to test with a controlled cache file, so we'll write to
// the real ~/.nansen/update-check.json and clean up after.
const CONFIG_DIR = path.join(os.homedir(), '.nansen');
const CACHE_FILE = path.join(CONFIG_DIR, 'update-check.json');

let savedCacheContent = null;

function backupCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      savedCacheContent = fs.readFileSync(CACHE_FILE, 'utf8');
    }
  } catch { /* ignore */ }
}

function restoreCache() {
  try {
    if (savedCacheContent !== null) {
      fs.writeFileSync(CACHE_FILE, savedCacheContent);
    } else if (fs.existsSync(CACHE_FILE)) {
      fs.unlinkSync(CACHE_FILE);
    }
  } catch { /* ignore */ }
  savedCacheContent = null;
}

function writeCache(data) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
}

function removeCache() {
  try { fs.unlinkSync(CACHE_FILE); } catch { /* ignore */ }
}

// =================== getUpdateNotification ===================

describe('getUpdateNotification', () => {
  let getUpdateNotification;

  beforeEach(async () => {
    backupCache();
    // Clear env vars
    delete process.env.NO_UPDATE_NOTIFIER;
    delete process.env.CI;
    // Fresh import each time to avoid module caching issues
    const mod = await import('../update-check.js');
    getUpdateNotification = mod.getUpdateNotification;
  });

  afterEach(() => {
    restoreCache();
  });

  it('should return notification when newer version available', () => {
    writeCache({ latest: '2.0.0', checkedAt: Date.now() });
    const result = getUpdateNotification('1.3.0');
    expect(result).toContain('Update available');
    expect(result).toContain('1.3.0');
    expect(result).toContain('2.0.0');
    expect(result).toContain('npm i -g nansen-cli');
  });

  it('should return null when on latest version', () => {
    writeCache({ latest: '1.3.0', checkedAt: Date.now() });
    const result = getUpdateNotification('1.3.0');
    expect(result).toBeNull();
  });

  it('should return null when on newer version than registry', () => {
    writeCache({ latest: '1.2.0', checkedAt: Date.now() });
    const result = getUpdateNotification('1.3.0');
    expect(result).toBeNull();
  });

  it('should compare major versions correctly', () => {
    writeCache({ latest: '2.0.0', checkedAt: Date.now() });
    expect(getUpdateNotification('1.9.9')).toContain('2.0.0');
  });

  it('should compare minor versions correctly', () => {
    writeCache({ latest: '1.4.0', checkedAt: Date.now() });
    expect(getUpdateNotification('1.3.9')).toContain('1.4.0');
  });

  it('should compare patch versions correctly', () => {
    writeCache({ latest: '1.3.1', checkedAt: Date.now() });
    expect(getUpdateNotification('1.3.0')).toContain('1.3.1');
  });

  it('should return null when no cache file exists', () => {
    removeCache();
    const result = getUpdateNotification('1.3.0');
    expect(result).toBeNull();
  });

  it('should return null when cache has no latest field', () => {
    writeCache({ checkedAt: Date.now() });
    const result = getUpdateNotification('1.3.0');
    expect(result).toBeNull();
  });

  it('should return null when cache file is invalid JSON', () => {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
    }
    fs.writeFileSync(CACHE_FILE, 'not json');
    const result = getUpdateNotification('1.3.0');
    expect(result).toBeNull();
  });

  it('should return null when NO_UPDATE_NOTIFIER is set', () => {
    writeCache({ latest: '99.0.0', checkedAt: Date.now() });
    process.env.NO_UPDATE_NOTIFIER = '1';
    const result = getUpdateNotification('1.3.0');
    expect(result).toBeNull();
  });

  it('should return null when CI is set', () => {
    writeCache({ latest: '99.0.0', checkedAt: Date.now() });
    process.env.CI = 'true';
    const result = getUpdateNotification('1.3.0');
    expect(result).toBeNull();
  });
});

// =================== scheduleUpdateCheck ===================

describe('scheduleUpdateCheck', () => {
  let scheduleUpdateCheck;

  beforeEach(async () => {
    backupCache();
    delete process.env.NO_UPDATE_NOTIFIER;
    delete process.env.CI;

    const mod = await import('../update-check.js');
    scheduleUpdateCheck = mod.scheduleUpdateCheck;
  });

  afterEach(() => {
    restoreCache();
  });

  it('should skip when NO_UPDATE_NOTIFIER is set', () => {
    process.env.NO_UPDATE_NOTIFIER = '1';
    removeCache();
    scheduleUpdateCheck();
    // No cache file should be written synchronously (spawn is skipped)
    expect(fs.existsSync(CACHE_FILE)).toBe(false);
  });

  it('should skip when CI is set', () => {
    process.env.CI = 'true';
    removeCache();
    scheduleUpdateCheck();
    expect(fs.existsSync(CACHE_FILE)).toBe(false);
  });

  it('should not throw when cache is fresh', () => {
    writeCache({ latest: '1.3.0', checkedAt: Date.now() });
    expect(() => scheduleUpdateCheck()).not.toThrow();
  });

  it('should not throw when cache is stale', () => {
    writeCache({ latest: '1.3.0', checkedAt: Date.now() - 25 * 60 * 60 * 1000 });
    // Spy inline to prevent a real network spawn from writing to the shared cache
    // file during subsequent CLI integration tests (race condition). Restoring
    // immediately after keeps the spy scoped to this test only.
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockReturnValue({ unref: vi.fn() });
    expect(() => scheduleUpdateCheck()).not.toThrow();
    spawnSpy.mockRestore();
  });

  it('should not throw when no cache exists', () => {
    removeCache();
    // Same race condition guard as the stale test above.
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockReturnValue({ unref: vi.fn() });
    expect(() => scheduleUpdateCheck()).not.toThrow();
    spawnSpy.mockRestore();
  });

  it('should not throw when cache is invalid JSON', () => {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
    }
    fs.writeFileSync(CACHE_FILE, 'invalid');
    expect(() => scheduleUpdateCheck()).not.toThrow();
  });
});

// =================== CLI Integration ===================

describe('update notification in CLI', () => {
  let outputs;
  let errors;
  let _exitCode;

  beforeEach(() => {
    backupCache();
    delete process.env.NO_UPDATE_NOTIFIER;
    delete process.env.CI;
    outputs = [];
    errors = [];
    _exitCode = null;
  });

  afterEach(() => {
    restoreCache();
  });

  const mockDeps = () => ({
    output: (msg) => outputs.push(msg),
    errorOutput: (msg) => errors.push(msg),
    exit: (code) => { _exitCode = code; }
  });

  it('should show update notification on stderr for help command', async () => {
    writeCache({ latest: '99.0.0', checkedAt: Date.now() });
    const { runCLI } = await import('../cli.js');
    await runCLI(['help'], mockDeps());

    expect(errors.some(e => e.includes('Update available'))).toBe(true);
    expect(errors.some(e => e.includes('99.0.0'))).toBe(true);
  });

  it('should NOT show update notification for --version', async () => {
    writeCache({ latest: '99.0.0', checkedAt: Date.now() });
    const { runCLI } = await import('../cli.js');
    await runCLI(['--version'], mockDeps());

    expect(errors.length).toBe(0);
    expect(outputs.length).toBe(1); // just the version
  });

  it('should NOT show notification when version is current', async () => {
    writeCache({ latest: '1.3.0', checkedAt: Date.now() });
    const { runCLI } = await import('../cli.js');
    await runCLI(['help'], mockDeps());

    expect(errors.length).toBe(0);
  });

  it('should NOT show notification when NO_UPDATE_NOTIFIER set', async () => {
    writeCache({ latest: '99.0.0', checkedAt: Date.now() });
    process.env.NO_UPDATE_NOTIFIER = '1';
    const { runCLI } = await import('../cli.js');
    await runCLI(['help'], mockDeps());

    expect(errors.length).toBe(0);
  });

  it('should show update notification for command --help', async () => {
    writeCache({ latest: '99.0.0', checkedAt: Date.now() });
    const { runCLI } = await import('../cli.js');
    await runCLI(['smart-money', '--help'], mockDeps());

    expect(errors.some(e => e.includes('Update available'))).toBe(true);
    expect(errors.some(e => e.includes('99.0.0'))).toBe(true);
  });

  it('should show update notification for subcommand --help', async () => {
    writeCache({ latest: '99.0.0', checkedAt: Date.now() });
    const { runCLI } = await import('../cli.js');
    await runCLI(['smart-money', 'netflow', '--help'], mockDeps());

    expect(errors.some(e => e.includes('Update available'))).toBe(true);
    expect(errors.some(e => e.includes('99.0.0'))).toBe(true);
  });

  it('should show update notification for simple command --help', async () => {
    writeCache({ latest: '99.0.0', checkedAt: Date.now() });
    const { runCLI } = await import('../cli.js');
    await runCLI(['schema', '--help'], mockDeps());

    expect(errors.some(e => e.includes('Update available'))).toBe(true);
  });

  it('should NOT show notification on stderr for API errors (limited to help only)', async () => {
    writeCache({ latest: '99.0.0', checkedAt: Date.now() });
    const { runCLI } = await import('../cli.js');
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockRejectedValue(new Error('fail'));
      }
    };
    await runCLI(['smart-money', 'netflow'], deps);

    expect(errors.some(e => e.includes('Update available'))).toBe(false);
  });

  it('should NOT show notification on stderr for successful commands (limited to help only)', async () => {
    writeCache({ latest: '99.0.0', checkedAt: Date.now() });
    const { runCLI } = await import('../cli.js');
    const deps = {
      ...mockDeps(),
      NansenAPIClass: function MockAPI() {
        this.smartMoneyNetflow = vi.fn().mockResolvedValue({ data: [] });
      }
    };
    await runCLI(['smart-money', 'netflow'], deps);

    expect(errors.some(e => e.includes('Update available'))).toBe(false);
    // stdout should still have the JSON data
    expect(outputs.length).toBe(1);
    expect(() => JSON.parse(outputs[0])).not.toThrow();
  });
});
