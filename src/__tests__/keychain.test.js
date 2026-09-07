/**
 * Tests for keychain module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

// Mock child_process before importing keychain
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { storePassword, retrievePassword, deletePassword, deleteCredentialsFile, resolvePassword, passwordSource } from '../keychain.js';

describe('keychain', () => {
  let originalPlatform;
  let originalEnv;
  let tempDir;

  beforeEach(() => {
    originalPlatform = process.platform;
    originalEnv = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-keychain-test-'));
    process.env.HOME = tempDir;
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setPlatform(platform) {
    Object.defineProperty(process, 'platform', { value: platform });
  }

  describe('storePassword', () => {
    it('should store in macOS keychain and return keychain method', () => {
      setPlatform('darwin');
      execFileSync.mockReturnValue(Buffer.from(''));
      const result = storePassword('mypassword');
      expect(result).toEqual({ stored: true, method: 'keychain' });
      expect(execFileSync).toHaveBeenCalledWith(
        '/usr/bin/security',
        ['add-generic-password', '-s', 'nansen-cli', '-a', 'wallet-password', '-w', 'mypassword', '-U'],
        expect.objectContaining({ timeout: 5000 })
      );
    });

    it('should store in Linux secret-tool and return keychain method', () => {
      setPlatform('linux');
      execFileSync.mockReturnValue(Buffer.from(''));
      const result = storePassword('mypassword');
      expect(result).toEqual({ stored: true, method: 'keychain' });
    });

    it('should fall back to .credentials file when keychain fails', () => {
      setPlatform('darwin');
      execFileSync.mockImplementation(() => { throw new Error('keychain error'); });
      // Ensure wallets dir exists
      fs.mkdirSync(path.join(tempDir, '.nansen', 'wallets'), { recursive: true });
      const result = storePassword('mypassword');
      expect(result).toEqual({ stored: true, method: 'file' });

      const credPath = path.join(tempDir, '.nansen', 'wallets', '.credentials');
      expect(fs.existsSync(credPath)).toBe(true);
      const content = fs.readFileSync(credPath, 'utf8');
      expect(content).toContain('NANSEN_WALLET_PASSWORD_B64=');
      const b64 = content.match(/NANSEN_WALLET_PASSWORD_B64=(.+)/)[1].trim();
      expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('mypassword');
      if (originalPlatform !== 'win32') {
        expect(fs.statSync(credPath).mode & 0o777).toBe(0o600);
      }
    });

    it.skipIf(process.platform === 'win32')('should tighten permissions when rewriting an existing credentials file on POSIX', () => {
      setPlatform('linux');
      execFileSync.mockImplementation(() => { throw new Error('secret-tool unavailable'); });

      const credDir = path.join(tempDir, '.nansen', 'wallets');
      const credPath = path.join(credDir, '.credentials');
      fs.mkdirSync(credDir, { recursive: true });
      fs.writeFileSync(credPath, 'old credentials\n');
      // writeFileSync's mode is filtered by the process umask, so set and
      // verify the insecure starting state explicitly.
      fs.chmodSync(credPath, 0o644);
      expect(fs.statSync(credPath).mode & 0o777).toBe(0o644);

      expect(storePassword('replacement-password')).toEqual({ stored: true, method: 'file' });
      expect(fs.statSync(credPath).mode & 0o777).toBe(0o600);
      expect(retrievePassword()).toEqual({ password: 'replacement-password', source: 'file' });
    });

    it.skipIf(process.platform === 'win32')('should refuse to overwrite a credentials symlink on POSIX', () => {
      setPlatform('linux');
      execFileSync.mockImplementation(() => { throw new Error('secret-tool unavailable'); });

      const credDir = path.join(tempDir, '.nansen', 'wallets');
      const credPath = path.join(credDir, '.credentials');
      const targetPath = path.join(tempDir, 'symlink-target');
      fs.mkdirSync(credDir, { recursive: true });
      fs.writeFileSync(targetPath, 'leave unchanged\n');
      fs.symlinkSync(targetPath, credPath);

      expect(storePassword('replacement-password')).toEqual({ stored: false, method: 'none' });
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('leave unchanged\n');
    });

    it('should fall back to .credentials on unsupported platform', () => {
      setPlatform('freebsd');
      fs.mkdirSync(path.join(tempDir, '.nansen', 'wallets'), { recursive: true });
      const result = storePassword('mypassword');
      expect(result).toEqual({ stored: true, method: 'file' });
    });

    it('should fall back to .credentials on Windows (no keychain support)', () => {
      setPlatform('win32');
      fs.mkdirSync(path.join(tempDir, '.nansen', 'wallets'), { recursive: true });
      const result = storePassword('mypassword');
      expect(result).toEqual({ stored: true, method: 'file' });
      expect(execFileSync).not.toHaveBeenCalled();
    });
  });

  describe('retrievePassword', () => {
    it('should prefer env var over everything', () => {
      setPlatform('darwin');
      process.env.NANSEN_WALLET_PASSWORD = 'env-password';
      execFileSync.mockReturnValue(Buffer.from('keychain-password'));
      const result = retrievePassword();
      expect(result).toEqual({ password: 'env-password', source: 'env' });
    });

    it('should retrieve from macOS keychain', () => {
      setPlatform('darwin');
      delete process.env.NANSEN_WALLET_PASSWORD;
      execFileSync.mockReturnValue(Buffer.from('keychain-password\n'));
      const result = retrievePassword();
      expect(result).toEqual({ password: 'keychain-password', source: 'keychain' });
    });

    it('should fall back to .credentials file (base64 format)', () => {
      setPlatform('darwin');
      delete process.env.NANSEN_WALLET_PASSWORD;
      execFileSync.mockImplementation(() => { throw new Error('not found'); });

      const credDir = path.join(tempDir, '.nansen', 'wallets');
      fs.mkdirSync(credDir, { recursive: true });
      const b64 = Buffer.from('file-password', 'utf8').toString('base64');
      fs.writeFileSync(path.join(credDir, '.credentials'), `NANSEN_WALLET_PASSWORD_B64=${b64}\n`);

      const result = retrievePassword();
      expect(result).toEqual({ password: 'file-password', source: 'file' });
    });

    it('should read legacy plain-text .credentials file', () => {
      setPlatform('darwin');
      delete process.env.NANSEN_WALLET_PASSWORD;
      execFileSync.mockImplementation(() => { throw new Error('not found'); });

      const credDir = path.join(tempDir, '.nansen', 'wallets');
      fs.mkdirSync(credDir, { recursive: true });
      fs.writeFileSync(path.join(credDir, '.credentials'), 'NANSEN_WALLET_PASSWORD=legacy-password\n');

      const result = retrievePassword();
      expect(result).toEqual({ password: 'legacy-password', source: 'file' });
    });

    it('should return null when nothing available', () => {
      setPlatform('freebsd');
      delete process.env.NANSEN_WALLET_PASSWORD;
      const result = retrievePassword();
      expect(result).toEqual({ password: null, source: null });
    });

    it('should return null for empty keychain result', () => {
      setPlatform('darwin');
      delete process.env.NANSEN_WALLET_PASSWORD;
      execFileSync.mockReturnValue(Buffer.from(''));
      const result = retrievePassword();
      // keychain returned empty, no file either
      expect(result).toEqual({ password: null, source: null });
    });
  });

  describe('deletePassword', () => {
    it('should delete from both keychain and file', () => {
      setPlatform('darwin');
      execFileSync.mockReturnValue(Buffer.from(''));

      const credDir = path.join(tempDir, '.nansen', 'wallets');
      fs.mkdirSync(credDir, { recursive: true });
      fs.writeFileSync(path.join(credDir, '.credentials'), 'NANSEN_WALLET_PASSWORD=test\n');

      const result = deletePassword();
      expect(result.keychain).toBe(true);
      expect(result.file).toBe(true);
      expect(fs.existsSync(path.join(credDir, '.credentials'))).toBe(false);
    });

    it('should handle keychain failure gracefully', () => {
      setPlatform('darwin');
      execFileSync.mockImplementation(() => { throw new Error('not found'); });
      const result = deletePassword();
      expect(result.keychain).toBe(false);
    });

    it('should return file: false when no .credentials file exists', () => {
      setPlatform('darwin');
      execFileSync.mockImplementation(() => { throw new Error('not found'); });
      const result = deletePassword();
      expect(result.file).toBe(false);
    });
  });

  describe('deleteCredentialsFile', () => {
    it('should delete only the .credentials file, not keychain', () => {
      setPlatform('darwin');
      const credDir = path.join(tempDir, '.nansen', 'wallets');
      fs.mkdirSync(credDir, { recursive: true });
      fs.writeFileSync(path.join(credDir, '.credentials'), 'NANSEN_WALLET_PASSWORD=test\n');

      const result = deleteCredentialsFile();
      expect(result).toBe(true);
      expect(fs.existsSync(path.join(credDir, '.credentials'))).toBe(false);
      // Should NOT have called execFileSync (no keychain delete)
      expect(execFileSync).not.toHaveBeenCalled();
    });
  });

  describe('resolvePassword', () => {
    it('should return password string from env', () => {
      process.env.NANSEN_WALLET_PASSWORD = 'env-pw';
      expect(resolvePassword()).toBe('env-pw');
    });

    it('should return password from keychain', () => {
      setPlatform('darwin');
      delete process.env.NANSEN_WALLET_PASSWORD;
      execFileSync.mockReturnValue(Buffer.from('kc-pw\n'));
      expect(resolvePassword()).toBe('kc-pw');
    });

    it('should return null when nothing available', () => {
      setPlatform('freebsd');
      delete process.env.NANSEN_WALLET_PASSWORD;
      expect(resolvePassword()).toBeNull();
    });
  });

  describe('passwordSource (metadata-only)', () => {
    it('reports env without touching the keychain', () => {
      process.env.NANSEN_WALLET_PASSWORD = 'env-pw';
      expect(passwordSource()).toBe('env');
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it('reports keychain on macOS without requesting the secret', () => {
      setPlatform('darwin');
      delete process.env.NANSEN_WALLET_PASSWORD;
      execFileSync.mockReturnValue(Buffer.from(''));
      expect(passwordSource()).toBe('keychain');
      // Attribute lookup only — the -w flag (print password) must be absent
      const args = execFileSync.mock.calls[0][1];
      expect(args).toContain('find-generic-password');
      expect(args).not.toContain('-w');
    });

    it('uses secret-tool search (attributes) rather than lookup (secret) on Linux', () => {
      setPlatform('linux');
      delete process.env.NANSEN_WALLET_PASSWORD;
      execFileSync.mockReturnValue(Buffer.from('[/org/freedesktop/secrets/collection/login/1]\nlabel = nansen-cli\n'));
      expect(passwordSource()).toBe('keychain');
      expect(execFileSync.mock.calls[0][1][0]).toBe('search');
    });

    it('reports file by pattern-matching the credentials file without decoding it', () => {
      setPlatform('freebsd');
      delete process.env.NANSEN_WALLET_PASSWORD;
      const walletsDir = path.join(tempDir, '.nansen', 'wallets');
      fs.mkdirSync(walletsDir, { recursive: true });
      fs.writeFileSync(path.join(walletsDir, '.credentials'), 'NANSEN_WALLET_PASSWORD_B64=cHc=\n');
      expect(passwordSource()).toBe('file');
    });

    it('returns null when no source exists', () => {
      setPlatform('freebsd');
      delete process.env.NANSEN_WALLET_PASSWORD;
      expect(passwordSource()).toBeNull();
    });
  });
});
