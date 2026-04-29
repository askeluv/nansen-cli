/**
 * Nansen CLI - Password Persistence
 * Stores/retrieves the wallet password, preferring the native OS credential
 * store and falling back to a base64-encoded credentials file (not encrypted).
 *
 * Resolution order (read):
 *   1. NANSEN_WALLET_PASSWORD env var
 *   2. OS keychain (macOS Keychain / Linux secret-tool / Windows cmdkey)
 *   3. ~/.nansen/wallets/.credentials file (insecure fallback)
 *
 * Storage order (write):
 *   1. Try OS keychain first
 *   2. Fall back to ~/.nansen/wallets/.credentials (chmod 600)
 *
 * Zero npm dependencies — uses native OS commands via child_process.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SERVICE = 'nansen-cli';
const ACCOUNT = 'wallet-password';
const TIMEOUT_MS = 5000;

function getCredentialsPath() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.nansen', 'wallets', '.credentials');
}

// ============= OS Keychain =============

function keychainStore(password) {
  try {
    if (process.platform === 'darwin') {
      // macOS `security` CLI requires -w <password> as argv — no stdin mode.
      // Unlike secret-tool, omitting the value prompts from the TTY, not stdin.
      // Exposure in process listings is brief (sub-second, execFileSync is synchronous).
      execFileSync('/usr/bin/security', [
        'add-generic-password',
        '-s', SERVICE,
        '-a', ACCOUNT,
        '-w', password,
        '-U',
      ], { timeout: TIMEOUT_MS, stdio: 'pipe' });
      return true;
    }

    if (process.platform === 'linux') {
      execFileSync('secret-tool', [
        'store',
        '--label', SERVICE,
        'service', SERVICE,
        'account', ACCOUNT,
      ], { input: password, timeout: TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'] });
      return true;
    }

    // Windows: no reliable built-in CLI for credential read-back.
    // cmdkey stores but can't retrieve passwords. Falls through to .credentials file.
    return false;
  } catch {
    return false;
  }
}

function keychainRetrieve() {
  try {
    if (process.platform === 'darwin') {
      const result = execFileSync('/usr/bin/security', [
        'find-generic-password',
        '-s', SERVICE,
        '-a', ACCOUNT,
        '-w',
      ], { timeout: TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'] });
      const pw = result.toString().trim();
      return pw || null;
    }

    if (process.platform === 'linux') {
      const result = execFileSync('secret-tool', [
        'lookup',
        'service', SERVICE,
        'account', ACCOUNT,
      ], { timeout: TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'] });
      const pw = result.toString().trim();
      return pw || null;
    }

    // Windows: no reliable built-in CLI for credential read-back.
    return null;
  } catch {
    return null;
  }
}

function keychainDeleteEntry() {
  try {
    if (process.platform === 'darwin') {
      execFileSync('/usr/bin/security', [
        'delete-generic-password',
        '-s', SERVICE,
        '-a', ACCOUNT,
      ], { timeout: TIMEOUT_MS, stdio: 'pipe' });
      return true;
    }

    if (process.platform === 'linux') {
      execFileSync('secret-tool', [
        'clear',
        'service', SERVICE,
        'account', ACCOUNT,
      ], { timeout: TIMEOUT_MS, stdio: 'pipe' });
      return true;
    }

    // Windows: no keychain entries to delete (uses .credentials file).
    return false;
  } catch {
    return false;
  }
}

// ============= Credentials File Fallback =============

function credentialsFileRead() {
  try {
    const filePath = getCredentialsPath();
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8').trim();
    // New format: base64-encoded (handles passwords with newlines/special chars)
    const b64Match = content.match(/^NANSEN_WALLET_PASSWORD_B64=(.+)$/m);
    if (b64Match) return Buffer.from(b64Match[1].trim(), 'base64').toString('utf8');
    // Legacy format: plain text (backward compat)
    const match = content.match(/^NANSEN_WALLET_PASSWORD=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function credentialsFileWrite(password) {
  try {
    const filePath = getCredentialsPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    }
    const encoded = Buffer.from(password, 'utf8').toString('base64');
    fs.writeFileSync(filePath, `NANSEN_WALLET_PASSWORD_B64=${encoded}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function credentialsFileDelete() {
  try {
    const filePath = getCredentialsPath();
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

// ============= Public API =============

/**
 * Store a password. Tries OS keychain first, falls back to .credentials file.
 * @param {string} password
 * @returns {{ stored: boolean, method: 'keychain'|'file'|'none' }}
 */
export function storePassword(password) {
  if (keychainStore(password)) {
    return { stored: true, method: 'keychain' };
  }
  if (credentialsFileWrite(password)) {
    return { stored: true, method: 'file' };
  }
  return { stored: false, method: 'none' };
}

/**
 * Retrieve the wallet password from OS keychain or .credentials file.
 * @returns {{ password: string|null, source: 'env'|'keychain'|'file'|null }}
 */
export function retrievePassword() {
  const envPw = process.env.NANSEN_WALLET_PASSWORD;
  if (envPw) return { password: envPw, source: 'env' };

  const keychainPw = keychainRetrieve();
  if (keychainPw) return { password: keychainPw, source: 'keychain' };

  const filePw = credentialsFileRead();
  if (filePw) return { password: filePw, source: 'file' };

  return { password: null, source: null };
}

/**
 * Delete the wallet password from all stores.
 * @returns {{ keychain: boolean, file: boolean }}
 */
export function deletePassword() {
  return {
    keychain: keychainDeleteEntry(),
    file: credentialsFileDelete(),
  };
}

/**
 * Delete only the .credentials file (not the keychain entry).
 * Used by `wallet secure` after migrating to keychain.
 * @returns {boolean}
 */
export function deleteCredentialsFile() {
  return credentialsFileDelete();
}

/**
 * Resolve the wallet password from available sources.
 * Order: env var → OS keychain → .credentials file → null
 * @returns {string|null}
 */
export function resolvePassword() {
  return retrievePassword().password;
}

