/**
 * Tests for src/doctor.js — offline auth status and doctor diagnostics.
 * All state lives in a temp HOME; the keychain is stubbed via the
 * passwordSourceFn seam, so nothing touches the real machine or network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getAuthStatus, runDoctorChecks, runConnectivityChecks, formatDoctorReport, maskKey } from '../doctor.js';
import { buildCommands, HELP, SCHEMA } from '../cli.js';

describe('doctor', () => {
  let tempDir;
  let env;

  // deps that make every check deterministic: isolated HOME, no env
  // credentials, no keychain (linux resolves via PATH, which the controlled
  // env leaves unset), no repo-local dev config.json
  const deps = (overrides = {}) => ({
    env,
    passwordSourceFn: () => null,
    devConfigPath: path.join(tempDir, 'nonexistent-dev-config.json'),
    platform: 'linux',
    ...overrides,
  });

  const nansenDir = () => path.join(tempDir, '.nansen');
  const walletsDir = () => path.join(nansenDir(), 'wallets');

  const writeConfig = (config) => {
    fs.mkdirSync(nansenDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(nansenDir(), 'config.json'), JSON.stringify(config), { mode: 0o600 });
  };

  const writeWallet = (name, wallet = { provider: 'local' }) => {
    fs.mkdirSync(walletsDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(walletsDir(), `${name}.json`), JSON.stringify({ name, ...wallet }), { mode: 0o600 });
  };

  const writeWalletConfig = (config) => {
    fs.mkdirSync(walletsDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(walletsDir(), 'config.json'), JSON.stringify(config), { mode: 0o600 });
  };

  const findCheck = (checks, id) => checks.find(c => c.id === id);

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-doctor-test-'));
    env = { HOME: tempDir };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('maskKey', () => {
    it('masks long keys to first and last 4 chars', () => {
      expect(maskKey('nk_1234567890abcdef')).toBe('nk_1…cdef');
    });

    it('fully masks short keys', () => {
      expect(maskKey('short')).toBe('****');
      // first4+last4 of an 8-11 char key would disclose most of it
      expect(maskKey('12345678')).toBe('****');
      expect(maskKey('12345678901')).toBe('****');
      expect(maskKey('123456789012')).toBe('1234…9012');
    });

    it('returns null for empty or non-string input', () => {
      expect(maskKey('')).toBeNull();
      expect(maskKey(null)).toBeNull();
      expect(maskKey(undefined)).toBeNull();
    });
  });

  describe('getAuthStatus', () => {
    it('reports logged out with no config anywhere', () => {
      const status = getAuthStatus(deps());
      expect(status.logged_in).toBe(false);
      expect(status.api_key).toEqual({ present: false, source: null, masked: null });
      expect(status.config_file.exists).toBe(false);
      expect(status.config_file.path).toBe(path.join(nansenDir(), 'config.json'));
      expect(status.base_url).toEqual({ value: 'https://api.nansen.ai', source: 'default' });
      expect(status.offline).toBe(true);
    });

    it('reports config-file key with masked value', () => {
      writeConfig({ apiKey: 'nk_1234567890abcdef', baseUrl: 'https://api.nansen.ai' });
      const status = getAuthStatus(deps());
      expect(status.logged_in).toBe(true);
      expect(status.api_key.source).toBe('config');
      expect(status.api_key.masked).toBe('nk_1…cdef');
      expect(status.config_file.exists).toBe(true);
      // Never leak the full key anywhere in the payload
      expect(JSON.stringify(status)).not.toContain('nk_1234567890abcdef');
    });

    it('env var overrides config-file key', () => {
      writeConfig({ apiKey: 'nk_config_key_0000' });
      env.NANSEN_API_KEY = 'nk_env_key_1111';
      const status = getAuthStatus(deps());
      expect(status.api_key.source).toBe('env');
      expect(status.api_key.masked).toBe('nk_e…1111');
    });

    it('reports base URL override from env', () => {
      env.NANSEN_BASE_URL = 'https://api.example.dev';
      const status = getAuthStatus(deps());
      expect(status.base_url).toEqual({ value: 'https://api.example.dev', source: 'env' });
    });

    it('reports an unreadable wallets directory instead of "no wallets"', () => {
      writeWallet('trading');
      fs.chmodSync(walletsDir(), 0o000);
      try {
        const status = getAuthStatus(deps());
        expect(status.x402.wallets_dir_error).toBe('unreadable');
      } finally {
        fs.chmodSync(walletsDir(), 0o700);
      }
    });

    it('reports dev-config as a distinct key source', () => {
      const devConfigPath = path.join(tempDir, 'dev-config.json');
      fs.writeFileSync(devConfigPath, JSON.stringify({ apiKey: 'nk_dev_key_123456' }));
      const status = getAuthStatus(deps({ devConfigPath }));
      expect(status.logged_in).toBe(true);
      expect(status.api_key.source).toBe('dev-config');
      // The standard config file genuinely does not exist — no contradiction
      expect(status.config_file.exists).toBe(false);
    });

    it('surfaces a corrupt config file instead of a clean "not logged in"', () => {
      fs.mkdirSync(nansenDir(), { recursive: true });
      fs.writeFileSync(path.join(nansenDir(), 'config.json'), 'not json{');
      const status = getAuthStatus(deps());
      expect(status.logged_in).toBe(false);
      expect(status.config_file.exists).toBe(true);
      expect(status.config_file.error).toBe('parse');
    });

    it('surfaces an unreadable config file distinctly', () => {
      writeConfig({ apiKey: 'nk_1234567890abcdef' });
      fs.chmodSync(path.join(nansenDir(), 'config.json'), 0o000);
      try {
        const status = getAuthStatus(deps());
        expect(status.logged_in).toBe(false);
        expect(status.config_file.error).toBe('unreadable');
      } finally {
        fs.chmodSync(path.join(nansenDir(), 'config.json'), 0o600);
      }
    });

    it('reports no config error for a healthy config file', () => {
      writeConfig({ apiKey: 'nk_1234567890abcdef' });
      expect(getAuthStatus(deps()).config_file.error).toBeNull();
    });

    it('reports x402 wallet readiness', () => {
      writeWallet('trading');
      writeWallet('privy-1', { provider: 'privy' });
      writeWalletConfig({ defaultWallet: 'trading', passwordHash: null });
      const status = getAuthStatus(deps({
        passwordSourceFn: () => 'keychain',
      }));
      expect(status.x402.configured).toBe(true);
      expect(status.x402.wallet_count).toBe(2);
      expect(status.x402.default_wallet).toBe('trading');
      expect(status.x402.default_wallet_provider).toBe('local');
      expect(status.x402.password).toEqual({ available: true, source: 'keychain', keychain_available: false });
    });

    it('reports no x402 setup when wallets dir is missing', () => {
      const status = getAuthStatus(deps());
      expect(status.x402.configured).toBe(false);
      expect(status.x402.wallet_count).toBe(0);
      expect(status.x402.default_wallet).toBeNull();
      expect(status.x402.password).toEqual({ available: false, source: null, keychain_available: false });
    });

    it('reports keychain availability from the platform toolchain', () => {
      // linux: available iff secret-tool is on PATH
      const binDir = path.join(tempDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'secret-tool'), '');
      env.PATH = binDir;
      expect(getAuthStatus(deps({ platform: 'linux' })).x402.password.keychain_available).toBe(true);
      env.PATH = path.join(tempDir, 'empty');
      expect(getAuthStatus(deps({ platform: 'linux' })).x402.password.keychain_available).toBe(false);
      expect(getAuthStatus(deps({ platform: 'win32' })).x402.password.keychain_available).toBe(false);
    });
  });

  describe('runDoctorChecks', () => {
    it('passes the node version check when at or above the engine requirement', () => {
      const checks = runDoctorChecks(deps({ nodeVersion: 'v20.0.0', engines: { node: '>=20.0.0' } }));
      expect(findCheck(checks, 'node-version').status).toBe('ok');
    });

    it('fails the node version check below the engine requirement', () => {
      const checks = runDoctorChecks(deps({ nodeVersion: 'v18.19.0', engines: { node: '>=20.0.0' } }));
      const check = findCheck(checks, 'node-version');
      expect(check.status).toBe('error');
      expect(check.fix).toContain('nodejs.org');
    });

    it('warns when NANSEN_BASE_URL override is active', () => {
      env.NANSEN_BASE_URL = 'https://api.example.dev';
      const checks = runDoctorChecks(deps());
      const check = findCheck(checks, 'base-url');
      expect(check.status).toBe('warn');
      expect(check.message).toContain('https://api.example.dev');
    });

    it('warns on a non-default base URL from the config file', () => {
      writeConfig({ apiKey: 'nk_1234567890abcdef', baseUrl: 'https://api.example.dev' });
      const check = findCheck(runDoctorChecks(deps()), 'base-url');
      expect(check.status).toBe('warn');
      expect(check.message).toContain('https://api.example.dev');
      expect(check.message).toContain('config.json');
    });

    it('reports ok for the default base URL saved in the config file', () => {
      writeConfig({ apiKey: 'nk_1234567890abcdef', baseUrl: 'https://api.nansen.ai' });
      expect(findCheck(runDoctorChecks(deps()), 'base-url').status).toBe('ok');
    });

    it('errors when the wallets directory cannot be read', () => {
      writeWallet('trading');
      fs.chmodSync(walletsDir(), 0o000);
      try {
        const check = findCheck(runDoctorChecks(deps()), 'wallets');
        expect(check.status).toBe('error');
        expect(check.message).toContain('cannot be read');
      } finally {
        fs.chmodSync(walletsDir(), 0o700);
      }
    });

    it('quotes paths in suggested fix commands', () => {
      writeConfig({ apiKey: 'nk_1234567890abcdef' });
      fs.chmodSync(path.join(nansenDir(), 'config.json'), 0o644);
      const check = findCheck(runDoctorChecks(deps()), 'config-perms');
      expect(check.fix).toContain(`chmod 600 "${path.join(nansenDir(), 'config.json')}"`);
    });

    it('warns with a login fix when no API key is configured', () => {
      const checks = runDoctorChecks(deps());
      const check = findCheck(checks, 'api-key');
      expect(check.status).toBe('warn');
      expect(check.fix).toContain('nansen login');
    });

    it('reports the API key masked with its source', () => {
      writeConfig({ apiKey: 'nk_1234567890abcdef' });
      const checks = runDoctorChecks(deps());
      const check = findCheck(checks, 'api-key');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('nk_1…cdef');
      expect(check.message).toContain('config file');
      expect(check.message).not.toContain('nk_1234567890abcdef');
    });

    it('warns when the env key shadows a different config-file key', () => {
      writeConfig({ apiKey: 'nk_config_key_0000' });
      env.NANSEN_API_KEY = 'nk_env_key_1111';
      const checks = runDoctorChecks(deps());
      expect(findCheck(checks, 'api-key-shadow').status).toBe('warn');
    });

    it('errors on a corrupt config file', () => {
      fs.mkdirSync(nansenDir(), { recursive: true });
      fs.writeFileSync(path.join(nansenDir(), 'config.json'), 'not json{');
      const check = findCheck(runDoctorChecks(deps()), 'config-file');
      expect(check.status).toBe('error');
      expect(check.message).toContain('not valid JSON');
      expect(check.fix).toContain('nansen login');
    });

    it('distinguishes an unreadable config file from a corrupt one', () => {
      writeConfig({ apiKey: 'nk_1234567890abcdef' });
      fs.chmodSync(path.join(nansenDir(), 'config.json'), 0o000);
      try {
        const check = findCheck(runDoctorChecks(deps()), 'config-file');
        expect(check.status).toBe('error');
        expect(check.message).toContain('cannot be read');
        // "nansen login" would not fix a permission problem
        expect(check.fix).not.toContain('nansen login');
      } finally {
        fs.chmodSync(path.join(nansenDir(), 'config.json'), 0o600);
      }
    });

    it('distinguishes unreadable wallet files from corrupt ones', () => {
      writeWallet('good');
      fs.writeFileSync(path.join(walletsDir(), 'corrupt.json'), 'not json{');
      fs.writeFileSync(path.join(walletsDir(), 'locked.json'), JSON.stringify({ provider: 'local' }));
      fs.chmodSync(path.join(walletsDir(), 'locked.json'), 0o000);
      try {
        const checks = runDoctorChecks(deps());
        const fileChecks = checks.filter(c => c.id === 'wallet-file');
        expect(fileChecks.find(c => c.message.includes('corrupt.json')).message).toContain('not valid JSON');
        expect(fileChecks.find(c => c.message.includes('locked.json')).message).toContain('cannot be read');
      } finally {
        fs.chmodSync(path.join(walletsDir(), 'locked.json'), 0o600);
      }
    });

    it('warns on insecure config file permissions', () => {
      writeConfig({ apiKey: 'nk_1234567890abcdef' });
      fs.chmodSync(path.join(nansenDir(), 'config.json'), 0o644);
      const checks = runDoctorChecks(deps());
      const check = findCheck(checks, 'config-perms');
      expect(check.status).toBe('warn');
      expect(check.fix).toContain('chmod 600');
    });

    it('skips POSIX permission checks on Windows', () => {
      writeConfig({ apiKey: 'nk_1234567890abcdef' });
      fs.chmodSync(path.join(nansenDir(), 'config.json'), 0o644);
      const checks = runDoctorChecks(deps({ platform: 'win32' }));
      expect(findCheck(checks, 'config-perms')).toBeUndefined();
    });

    it('reports wallets as optional info when none exist', () => {
      const checks = runDoctorChecks(deps());
      expect(findCheck(checks, 'wallets').status).toBe('info');
    });

    it('counts wallets and shows the default', () => {
      writeWallet('trading');
      writeWalletConfig({ defaultWallet: 'trading' });
      const checks = runDoctorChecks(deps({
        passwordSourceFn: () => 'keychain',
      }));
      const check = findCheck(checks, 'wallets');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('1 wallet');
      expect(check.message).toContain('default: trading');
    });

    it('errors when the default wallet has no file', () => {
      writeWallet('trading');
      writeWalletConfig({ defaultWallet: 'gone' });
      const checks = runDoctorChecks(deps());
      expect(findCheck(checks, 'default-wallet').status).toBe('error');
    });

    it('warns when the password lives in the insecure .credentials file', () => {
      writeWallet('trading');
      const checks = runDoctorChecks(deps({
        passwordSourceFn: () => 'file',
      }));
      const check = findCheck(checks, 'wallet-password');
      expect(check.status).toBe('warn');
      expect(check.fix).toContain('nansen wallet secure');
    });

    it('warns when wallets are password-protected but no password is stored', () => {
      writeWallet('trading');
      writeWalletConfig({ defaultWallet: 'trading', passwordHash: { salt: 'ab', hash: 'cd' } });
      const checks = runDoctorChecks(deps());
      const check = findCheck(checks, 'wallet-password');
      expect(check.status).toBe('warn');
      expect(check.message).toContain('no password is stored');
    });

    it('warns about a stale .credentials file when the active source is elsewhere', () => {
      writeWallet('trading');
      fs.writeFileSync(path.join(walletsDir(), '.credentials'), 'NANSEN_WALLET_PASSWORD_B64=cHc=\n', { mode: 0o600 });
      const checks = runDoctorChecks(deps({
        passwordSourceFn: () => 'keychain',
      }));
      expect(findCheck(checks, 'stale-credentials').status).toBe('warn');
    });

    it('warns when a Privy wallet exists without Privy env credentials', () => {
      writeWallet('server', { provider: 'privy' });
      const checks = runDoctorChecks(deps());
      expect(findCheck(checks, 'privy-env').status).toBe('warn');
    });

    it('does not warn about Privy when env credentials are set', () => {
      writeWallet('server', { provider: 'privy' });
      env.PRIVY_APP_ID = 'app';
      env.PRIVY_APP_SECRET = 'secret';
      const checks = runDoctorChecks(deps());
      expect(findCheck(checks, 'privy-env')).toBeUndefined();
    });

    it('counts response cache entries', () => {
      const cacheDir = path.join(nansenDir(), 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'a.json'), '{}');
      fs.writeFileSync(path.join(cacheDir, 'b.json'), '{}');
      const checks = runDoctorChecks(deps());
      expect(findCheck(checks, 'response-cache').message).toContain('2 entries');
    });

    it('reports cost map freshness', () => {
      fs.mkdirSync(nansenDir(), { recursive: true });
      fs.writeFileSync(path.join(nansenDir(), 'cost-map.json'), JSON.stringify({ costs: {}, fetchedAt: Date.now() - 2 * 3600 * 1000 }));
      const checks = runDoctorChecks(deps());
      expect(findCheck(checks, 'cost-map').message).toContain('fresh');
    });

    it('warns when the update-check cache shows a newer version', () => {
      fs.mkdirSync(nansenDir(), { recursive: true });
      fs.writeFileSync(path.join(nansenDir(), 'update-check.json'), JSON.stringify({ latest: '9.9.9', checkedAt: Date.now() }));
      const checks = runDoctorChecks(deps({ cliVersion: '1.0.0' }));
      const check = findCheck(checks, 'cli-version');
      expect(check.status).toBe('warn');
      expect(check.message).toContain('1.0.0 → 9.9.9');
    });

    it('reports up to date when the cached latest matches', () => {
      fs.mkdirSync(nansenDir(), { recursive: true });
      fs.writeFileSync(path.join(nansenDir(), 'update-check.json'), JSON.stringify({ latest: '1.0.0', checkedAt: Date.now() }));
      const checks = runDoctorChecks(deps({ cliVersion: '1.0.0' }));
      expect(findCheck(checks, 'cli-version').status).toBe('ok');
    });

    it('reports telemetry state with the same predicate telemetry.js uses', () => {
      expect(findCheck(runDoctorChecks(deps()), 'telemetry').message).toContain('enabled');
      // Only the literal '1' disables telemetry — '0'/'true'/'false' do not
      env.DO_NOT_TRACK = '0';
      expect(findCheck(runDoctorChecks(deps()), 'telemetry').message).toContain('enabled');
      env.DO_NOT_TRACK = '1';
      expect(findCheck(runDoctorChecks(deps()), 'telemetry').message).toContain('disabled');
    });

    it('clamps a future cost-map timestamp instead of reporting negative age', () => {
      fs.mkdirSync(nansenDir(), { recursive: true });
      fs.writeFileSync(path.join(nansenDir(), 'cost-map.json'), JSON.stringify({ costs: {}, fetchedAt: Date.now() + 5 * 3600 * 1000 }));
      const check = findCheck(runDoctorChecks(deps()), 'cost-map');
      expect(check.message).not.toContain('-');
      expect(check.message).toContain('fetched 0h ago');
    });

    it('reports keychain availability as a check', () => {
      expect(findCheck(runDoctorChecks(deps()), 'keychain').status).toBe('info');
      const binDir = path.join(tempDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'secret-tool'), '');
      env.PATH = binDir;
      expect(findCheck(runDoctorChecks(deps({ platform: 'linux' })), 'keychain').status).toBe('ok');
    });
  });

  describe('runConnectivityChecks', () => {
    it('reports the API as reachable on any HTTP response', async () => {
      const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      const [check] = await runConnectivityChecks(deps({ fetchFn }));
      expect(check.id).toBe('api-reachable');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('https://api.nansen.ai');
      expect(check.message).toContain('HTTP 200');
      // Unauthenticated probe: no headers, no API key
      expect(fetchFn.mock.calls[0][1].headers).toBeUndefined();
    });

    it('probes the overridden base URL', async () => {
      env.NANSEN_BASE_URL = 'https://api.example.dev';
      const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      const [check] = await runConnectivityChecks(deps({ fetchFn }));
      expect(fetchFn.mock.calls[0][0]).toBe('https://api.example.dev/openapi.json');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('HTTP 404');
    });

    it('reports a network failure as an error with a fix', async () => {
      const err = new Error('fetch failed');
      err.cause = { code: 'ECONNREFUSED' };
      const fetchFn = vi.fn().mockRejectedValue(err);
      const [check] = await runConnectivityChecks(deps({ fetchFn }));
      expect(check.status).toBe('error');
      expect(check.message).toContain('ECONNREFUSED');
      expect(check.fix).toContain('offline checks above remain valid');
    });

    it('reports a timeout distinctly', async () => {
      const abortErr = new Error('This operation was aborted');
      abortErr.name = 'AbortError';
      const fetchFn = vi.fn().mockRejectedValue(abortErr);
      const [check] = await runConnectivityChecks(deps({ fetchFn, timeoutMs: 123 }));
      expect(check.status).toBe('error');
      expect(check.message).toContain('timed out after 123ms');
    });
  });

  describe('formatDoctorReport', () => {
    it('renders icons, fixes, and a summary count', () => {
      const report = formatDoctorReport([
        { id: 'a', status: 'ok', message: 'all good' },
        { id: 'b', status: 'warn', message: 'be careful', fix: 'Run: nansen wallet secure' },
        { id: 'c', status: 'error', message: 'broken' },
      ], { cliVersion: '1.2.3' });
      expect(report).toContain('v1.2.3');
      expect(report).toContain('✓ all good');
      expect(report).toContain('⚠️  be careful');
      expect(report).toContain('Run: nansen wallet secure');
      expect(report).toContain('❌ broken');
      expect(report).toContain('1 error, 1 warning found.');
    });

    it('says no problems when everything is ok or info', () => {
      const report = formatDoctorReport([
        { id: 'a', status: 'ok', message: 'fine' },
        { id: 'b', status: 'info', message: 'fyi' },
      ]);
      expect(report).toContain('No problems found.');
    });
  });

  describe('CLI wiring', () => {
    let originalHome;
    let originalEnv;
    let logs;
    let commands;

    beforeEach(() => {
      originalHome = process.env.HOME;
      originalEnv = {
        NANSEN_API_KEY: process.env.NANSEN_API_KEY,
        NANSEN_BASE_URL: process.env.NANSEN_BASE_URL,
        NANSEN_WALLET_PASSWORD: process.env.NANSEN_WALLET_PASSWORD,
      };
      process.env.HOME = tempDir;
      delete process.env.NANSEN_API_KEY;
      delete process.env.NANSEN_BASE_URL;
      // Deterministic password source: keeps retrievePassword() off the real keychain
      process.env.NANSEN_WALLET_PASSWORD = 'test-pw';
      logs = [];
      commands = buildCommands({ log: (msg) => logs.push(msg), exit: vi.fn() });
    });

    afterEach(() => {
      process.env.HOME = originalHome;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('auth defaults to status and returns a data object', async () => {
      const result = await commands.auth([], null, {}, {});
      expect(result.offline).toBe(true);
      // logged_in may be true on dev machines with a repo-local config.json;
      // the hermetic getAuthStatus tests above pin the exact value.
      expect(typeof result.logged_in).toBe('boolean');
      expect(result.config_file.path).toBe(path.join(tempDir, '.nansen', 'config.json'));
    });

    it('auth rejects unknown subcommands', async () => {
      await expect(commands.auth(['whoami'], null, {}, {})).rejects.toThrow(/Unknown auth subcommand/);
    });

    it('doctor --offline prints a report and returns undefined without touching the network', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      try {
        const result = await commands.doctor([], null, { offline: true }, {});
        expect(result).toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
        const combined = logs.join('\n');
        expect(combined).toContain('offline diagnostics');
        expect(combined).toMatch(/error|warning|No problems found/);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('doctor runs the connectivity probe by default', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
      try {
        const result = await commands.doctor([], null, { json: true }, {});
        const connectivity = result.checks.find(c => c.id === 'api-reachable');
        expect(connectivity.status).toBe('ok');
        expect(result.offline).toBe(false);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('doctor --json --offline returns structured checks with no connectivity probe', async () => {
      const result = await commands.doctor([], null, { json: true, offline: true }, {});
      expect(Array.isArray(result.checks)).toBe(true);
      expect(result.checks.length).toBeGreaterThan(0);
      expect(result.checks.every(c => c.id && c.status && c.message)).toBe(true);
      expect(result.checks.find(c => c.id === 'api-reachable')).toBeUndefined();
      expect(result.offline).toBe(true);
      expect(typeof result.errors).toBe('number');
      expect(typeof result.warnings).toBe('number');
    });
  });

  describe('discoverability', () => {
    it('HELP lists auth and doctor', () => {
      expect(HELP).toContain('auth');
      expect(HELP).toContain('doctor');
    });

    it('SCHEMA documents auth status and doctor', () => {
      expect(SCHEMA.commands.auth.subcommands.status).toBeDefined();
      expect(SCHEMA.commands.doctor).toBeDefined();
      expect(SCHEMA.commands.doctor.options.json).toBeDefined();
    });
  });
});
