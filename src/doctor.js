/**
 * Nansen CLI - Offline diagnostics
 *
 * `nansen auth status` — where credentials come from, without any network call.
 * `nansen doctor`      — health checks over ~/.nansen, environment, and wallets.
 *
 * Everything in this module is offline by design: it reads local files, env
 * vars, and (for the wallet password) the OS keychain — never the network.
 * Paths are resolved lazily at call time so tests can point HOME at a temp dir.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { passwordSource } from './keychain.js';
import { isNewer } from './update-check.js';
import { isTelemetryDisabled } from './telemetry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_BASE_URL = 'https://api.nansen.ai';
const COST_MAP_STALE_MS = 24 * 60 * 60 * 1000;

// ============= Lazy Paths =============

function getHome(env) {
  return env.HOME || env.USERPROFILE || '';
}

function getConfigDir(env) {
  return path.join(getHome(env), '.nansen');
}

function getConfigFilePath(env) {
  return path.join(getConfigDir(env), 'config.json');
}

function getWalletsDir(env) {
  return path.join(getConfigDir(env), 'wallets');
}

function getCredentialsFilePath(env) {
  return path.join(getWalletsDir(env), '.credentials');
}

// ============= Local Readers (never throw) =============

/**
 * Read + parse a JSON file, distinguishing "cannot read it" (permissions, IO)
 * from "read it but it is not JSON" — the two need different diagnostics and
 * different fixes.
 */
function readJsonDetailed(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { data: null, error: 'unreadable' };
  }
  try {
    return { data: JSON.parse(raw), error: null };
  } catch {
    return { data: null, error: 'parse' };
  }
}

function readJson(filePath) {
  return readJsonDetailed(filePath).data;
}

/**
 * Mask an API key for display: enough to recognise it, never enough to use it.
 */
export function maskKey(key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  // Below 12 chars, first4+last4 would disclose most of the key
  if (key.length < 12) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

const DEV_CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/**
 * Resolve the API key and base URL the way src/api.js loadConfig() does —
 * ~/.nansen/config.json, then the repo-local dev config.json, then env
 * overrides — but lazily and without secrets leaving this function unmasked.
 */
function resolveAuthConfig(env, devConfigPath = DEV_CONFIG_PATH) {
  const userConfigPath = getConfigFilePath(env);

  let config = null;
  let configPath = null;
  let configError = null;

  if (fs.existsSync(userConfigPath)) {
    const result = readJsonDetailed(userConfigPath);
    config = result.data;
    configPath = userConfigPath;
    configError = result.error;
  }
  if (!config && fs.existsSync(devConfigPath)) {
    config = readJson(devConfigPath);
    if (config) configPath = devConfigPath;
  }

  let apiKey = config?.apiKey || null;
  let apiKeySource = apiKey ? (configPath === devConfigPath ? 'dev-config' : 'config') : null;
  if (env.NANSEN_API_KEY) {
    apiKey = env.NANSEN_API_KEY;
    apiKeySource = 'env';
  }

  let baseUrl = config?.baseUrl || DEFAULT_BASE_URL;
  let baseUrlSource = config?.baseUrl ? 'config' : 'default';
  if (env.NANSEN_BASE_URL) {
    baseUrl = env.NANSEN_BASE_URL;
    baseUrlSource = 'env';
  }

  return {
    apiKey,
    apiKeySource,
    baseUrl,
    baseUrlSource,
    configPath,
    configFileExists: fs.existsSync(userConfigPath),
    configError,
  };
}

/**
 * Enumerate local wallets without side effects — unlike listWallets(), this
 * never creates the wallets directory.
 */
function readWallets(env) {
  const dir = getWalletsDir(env);
  const result = {
    dir,
    dirExists: fs.existsSync(dir),
    dirError: null,
    wallets: [],
    defaultWallet: null,
    passwordHashSet: false,
    configError: null,
  };
  if (!result.dirExists) return result;

  const configFilePath = path.join(dir, 'config.json');
  const walletConfig = fs.existsSync(configFilePath) ? readJsonDetailed(configFilePath) : { data: null, error: null };
  result.configError = walletConfig.error;
  result.defaultWallet = walletConfig.data?.defaultWallet || null;
  result.passwordHashSet = Boolean(walletConfig.data?.passwordHash);

  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { result.dirError = 'unreadable'; }
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry === 'config.json') continue;
    const wallet = readJsonDetailed(path.join(dir, entry));
    result.wallets.push({
      name: entry.replace(/\.json$/, ''),
      provider: wallet.data?.provider || (wallet.data ? 'local' : null),
      error: wallet.error,
    });
  }
  return result;
}

function fileMode(filePath) {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * Whether an OS keychain is available for wallet password storage, mirroring
 * the platform support in src/keychain.js. Checks tool presence only — never
 * reads or writes an entry.
 */
function isKeychainAvailable(platform, env) {
  if (platform === 'darwin') return fs.existsSync('/usr/bin/security');
  if (platform === 'linux') {
    return (env.PATH || '').split(path.delimiter).some(dir => {
      try { return dir && fs.existsSync(path.join(dir, 'secret-tool')); } catch { return false; }
    });
  }
  return false; // Windows: keychain.js always falls back to the .credentials file
}

function isInsecureMode(mode) {
  return mode !== null && (mode & 0o077) !== 0;
}

// ============= auth status =============

/**
 * Offline authentication status. Reads config files, env vars, and the wallet
 * store; makes no network calls. Returns a data object (rendered as JSON by
 * the CLI layer, like `account`).
 */
export function getAuthStatus(deps = {}) {
  const {
    env = process.env,
    passwordSourceFn = passwordSource,
    devConfigPath = DEV_CONFIG_PATH,
    platform = process.platform,
  } = deps;

  const auth = resolveAuthConfig(env, devConfigPath);
  const walletInfo = readWallets(env);
  const pwSource = passwordSourceFn();
  const defaultEntry = walletInfo.wallets.find(w => w.name === walletInfo.defaultWallet) || null;

  return {
    logged_in: Boolean(auth.apiKey),
    api_key: {
      present: Boolean(auth.apiKey),
      source: auth.apiKeySource,
      masked: maskKey(auth.apiKey),
    },
    config_file: {
      path: getConfigFilePath(env),
      exists: auth.configFileExists,
      // 'parse' (corrupt JSON) | 'unreadable' (permissions/IO) | null — without
      // this, a broken config file is indistinguishable from "not logged in"
      error: auth.configError,
    },
    base_url: {
      value: auth.baseUrl,
      source: auth.baseUrlSource,
    },
    x402: {
      configured: walletInfo.wallets.length > 0,
      wallets_dir: walletInfo.dir,
      wallets_dir_error: walletInfo.dirError,
      wallet_count: walletInfo.wallets.length,
      default_wallet: walletInfo.defaultWallet,
      default_wallet_provider: defaultEntry?.provider || null,
      password: {
        available: pwSource !== null,
        source: pwSource,
        keychain_available: isKeychainAvailable(platform, env),
      },
    },
    offline: true,
  };
}

// ============= doctor =============

function check(id, status, message, fix = null) {
  const result = { id, status, message };
  if (fix) result.fix = fix;
  return result;
}

function parseEngineMajor(requirement) {
  const match = /(\d+)/.exec(requirement || '');
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Run all offline diagnostics. Returns an array of
 * { id, status: 'ok'|'warn'|'error'|'info', message, fix? } checks.
 */
export function runDoctorChecks(deps = {}) {
  const {
    env = process.env,
    passwordSourceFn = passwordSource,
    nodeVersion = process.version,
    cliVersion = null,
    engines = null,
    devConfigPath = DEV_CONFIG_PATH,
    platform = process.platform,
  } = deps;

  const checks = [];
  const auth = resolveAuthConfig(env, devConfigPath);

  // --- environment ---
  const requiredMajor = parseEngineMajor(engines?.node) ?? 20;
  const currentMajor = parseInt(nodeVersion.replace(/^v/, ''), 10);
  checks.push(currentMajor >= requiredMajor
    ? check('node-version', 'ok', `Node ${nodeVersion} (>= ${requiredMajor} required)`)
    : check('node-version', 'error', `Node ${nodeVersion} is below the required major version ${requiredMajor}`, `Install Node >= ${requiredMajor}: https://nodejs.org`));

  // Report the URL the CLI will actually use — a config file can set a
  // non-default base URL too, not just the env var
  if (auth.baseUrlSource === 'env') {
    checks.push(check('base-url', 'warn', `NANSEN_BASE_URL override active: ${auth.baseUrl}`, `Unset NANSEN_BASE_URL to use ${DEFAULT_BASE_URL}`));
  } else if (auth.baseUrl !== DEFAULT_BASE_URL) {
    checks.push(check('base-url', 'warn', `Non-default API base URL in ${auth.configPath}: ${auth.baseUrl}`, 'Run: nansen login (re-saves the default)'));
  } else {
    checks.push(check('base-url', 'ok', `API base URL: ${auth.baseUrl}`));
  }

  // --- auth ---
  if (auth.configError === 'unreadable') {
    checks.push(check('config-file', 'error', `${getConfigFilePath(env)} exists but cannot be read — permission problem?`, `Check ownership and mode: ls -l "${getConfigFilePath(env)}"`));
  } else if (auth.configError === 'parse') {
    checks.push(check('config-file', 'error', `${getConfigFilePath(env)} exists but is not valid JSON`, 'Run: nansen login (re-saves the file)'));
  }
  if (auth.apiKey) {
    const sourceLabel = auth.apiKeySource === 'env'
      ? 'NANSEN_API_KEY env var'
      : `config file ${auth.configPath}`;
    checks.push(check('api-key', 'ok', `API key found (${maskKey(auth.apiKey)}, source: ${sourceLabel})`));
    if (auth.apiKeySource === 'env' && auth.configFileExists && !auth.configError) {
      const fileKey = readJson(getConfigFilePath(env))?.apiKey;
      if (fileKey && fileKey !== auth.apiKey) {
        checks.push(check('api-key-shadow', 'warn', 'NANSEN_API_KEY env var overrides a different key saved in the config file'));
      }
    }
  } else {
    checks.push(check('api-key', auth.configFileExists ? 'error' : 'warn', 'No API key configured', 'Run: nansen login --api-key <key>  (or fund an x402 wallet for pay-per-call access)'));
  }
  // POSIX modes are meaningless on Windows — fs.stat reports 0o666 for every
  // file there, which would warn on all of them
  const posixModes = platform !== 'win32';
  if (posixModes) {
    const configMode = fileMode(getConfigFilePath(env));
    if (isInsecureMode(configMode)) {
      checks.push(check('config-perms', 'warn', `${getConfigFilePath(env)} has insecure permissions (${configMode.toString(8)})`, `Run: chmod 600 "${getConfigFilePath(env)}"`));
    }
  }

  // --- wallets / x402 ---
  const keychainAvailable = isKeychainAvailable(platform, env);
  checks.push(keychainAvailable
    ? check('keychain', 'ok', 'OS keychain available for wallet password storage')
    : check('keychain', 'info', 'No OS keychain on this platform — wallet passwords fall back to the .credentials file'));

  const walletInfo = readWallets(env);
  if (walletInfo.configError) {
    const problem = walletInfo.configError === 'unreadable' ? 'cannot be read — permission problem?' : 'is not valid JSON';
    checks.push(check('wallet-config', 'error', `${path.join(walletInfo.dir, 'config.json')} exists but ${problem}`));
  }
  if (walletInfo.dirError) {
    checks.push(check('wallets', 'error', `${walletInfo.dir} exists but cannot be read — permission problem?`, `Check ownership and mode: ls -ld "${walletInfo.dir}"`));
  } else if (!walletInfo.dirExists || walletInfo.wallets.length === 0) {
    checks.push(check('wallets', 'info', 'No local wallets (only needed for trading and x402 micropayments)', 'Run: nansen wallet create <name>'));
  } else {
    const defaultNote = walletInfo.defaultWallet ? `default: ${walletInfo.defaultWallet}` : 'no default set';
    checks.push(check('wallets', 'ok', `${walletInfo.wallets.length} wallet${walletInfo.wallets.length === 1 ? '' : 's'} in ${walletInfo.dir} (${defaultNote})`));
    if (walletInfo.defaultWallet && !walletInfo.wallets.some(w => w.name === walletInfo.defaultWallet)) {
      checks.push(check('default-wallet', 'error', `Default wallet "${walletInfo.defaultWallet}" has no wallet file`, 'Run: nansen wallet default <name>'));
    }
    for (const w of walletInfo.wallets.filter(w => w.error)) {
      const problem = w.error === 'unreadable' ? 'cannot be read — permission problem?' : 'is not valid JSON';
      checks.push(check('wallet-file', 'error', `Wallet file ${path.join(walletInfo.dir, `${w.name}.json`)} ${problem}`));
    }
    if (posixModes) {
      const walletsDirMode = fileMode(walletInfo.dir);
      if (isInsecureMode(walletsDirMode)) {
        checks.push(check('wallets-perms', 'warn', `${walletInfo.dir} has insecure permissions (${walletsDirMode.toString(8)})`, `Run: chmod 700 "${walletInfo.dir}"`));
      }
    }

    // Password storage — only relevant once wallets exist. Metadata-only:
    // the secret itself is never retrieved.
    const pwSource = passwordSourceFn();
    if (pwSource === 'file') {
      checks.push(check('wallet-password', 'warn', 'Wallet password stored in the insecure .credentials file', 'Run: nansen wallet secure  (migrates it to the OS keychain)'));
    } else if (pwSource) {
      checks.push(check('wallet-password', 'ok', `Wallet password available (source: ${pwSource})`));
    } else if (walletInfo.passwordHashSet) {
      checks.push(check('wallet-password', 'warn', 'Wallets are password-protected but no password is stored — x402 payments and trading will fail non-interactively', 'Set NANSEN_WALLET_PASSWORD, or store it: nansen wallet secure'));
    }
    if (pwSource !== 'file' && fs.existsSync(getCredentialsFilePath(env))) {
      checks.push(check('stale-credentials', 'warn', `${getCredentialsFilePath(env)} still exists but is not the active password source`, `Delete it: rm "${getCredentialsFilePath(env)}"`));
    }

    // Privy wallets need API credentials from the environment
    const hasPrivyWallet = walletInfo.wallets.some(w => w.provider === 'privy');
    if (hasPrivyWallet && (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET)) {
      checks.push(check('privy-env', 'warn', 'Privy wallet present but PRIVY_APP_ID / PRIVY_APP_SECRET are not set', 'Export both env vars to use Privy wallets'));
    }
  }

  // --- caches ---
  const cacheDir = path.join(getConfigDir(env), 'cache');
  let cacheCount = 0;
  try { cacheCount = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json')).length; } catch { /* missing dir */ }
  checks.push(check('response-cache', 'info', `Response cache: ${cacheCount} entr${cacheCount === 1 ? 'y' : 'ies'} (${cacheDir})`, cacheCount > 0 ? 'Clear with: nansen cache clear' : null));

  const costMap = readJson(path.join(getConfigDir(env), 'cost-map.json'));
  if (costMap?.fetchedAt) {
    // Clamp: a future fetchedAt (clock skew, corrupt cache) is not "fetched -5h ago"
    const ageMs = Math.max(0, Date.now() - costMap.fetchedAt);
    const fresh = ageMs < COST_MAP_STALE_MS;
    checks.push(check('cost-map', 'info', `Credit cost map: ${fresh ? 'fresh' : 'stale'} (fetched ${Math.round(ageMs / 3600000)}h ago)`));
  } else {
    checks.push(check('cost-map', 'info', 'Credit cost map not cached yet (refreshes on next nansen help)'));
  }

  if (cliVersion) {
    const updateCache = readJson(path.join(getConfigDir(env), 'update-check.json'));
    if (updateCache?.latest) {
      checks.push(isNewer(updateCache.latest, cliVersion)
        ? check('cli-version', 'warn', `Update available: ${cliVersion} → ${updateCache.latest}`, 'Run: npm i -g nansen-cli')
        : check('cli-version', 'ok', `nansen-cli ${cliVersion} is up to date`));
    } else {
      checks.push(check('cli-version', 'info', `nansen-cli ${cliVersion} (no update-check cache yet)`));
    }
  }

  const loAuth = readJson(path.join(getConfigDir(env), 'limit-order-auth.json'));
  if (loAuth?.expiresAt) {
    const valid = loAuth.expiresAt > Date.now() + 300_000;
    checks.push(check('limit-order-jwt', 'info', `Limit-order session: ${valid ? 'valid' : 'expired'} (re-authenticates automatically)`));
  }

  // --- telemetry ---
  checks.push(check('telemetry', 'info', isTelemetryDisabled(env) ? 'Telemetry disabled' : 'Anonymous telemetry enabled (disable: DO_NOT_TRACK=1)'));

  return checks;
}

/**
 * Safe connectivity check: an unauthenticated GET against the configured API
 * base URL. No API key is sent and no credits are consumed. Any HTTP response
 * proves reachability; only a network failure or timeout is a problem — so
 * `doctor` stays useful for diagnosing exactly the "API is unavailable" case.
 */
export async function runConnectivityChecks(deps = {}) {
  const {
    env = process.env,
    fetchFn = fetch,
    timeoutMs = 5000,
    devConfigPath = DEV_CONFIG_PATH,
  } = deps;

  const { baseUrl } = resolveAuthConfig(env, devConfigPath);
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchFn(`${baseUrl}/openapi.json`, { method: 'GET', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - started;
    return [check('api-reachable', 'ok', `API reachable: ${baseUrl} (HTTP ${response.status}, ${ms}ms)`)];
  } catch (error) {
    const reason = error.name === 'AbortError'
      ? `timed out after ${timeoutMs}ms`
      : (error.cause?.code || error.message);
    return [check('api-reachable', 'error', `API unreachable: ${baseUrl} (${reason})`, 'Check your network/proxy. The offline checks above remain valid.')];
  }
}

const STATUS_ICONS = { ok: '✓', warn: '⚠️ ', error: '❌', info: 'ℹ' };

/**
 * Render doctor checks as human-readable lines with a summary tail.
 */
export function formatDoctorReport(checks, { cliVersion = null, offline = false } = {}) {
  const lines = [];
  const mode = offline
    ? 'offline diagnostics (no network calls)'
    : 'diagnostics (local checks + a credit-free connectivity probe; --offline to skip network)';
  lines.push(`Nansen CLI doctor${cliVersion ? ` v${cliVersion}` : ''} — ${mode}`);
  lines.push('');
  for (const c of checks) {
    lines.push(`${STATUS_ICONS[c.status] || ' '} ${c.message}`);
    if (c.fix) lines.push(`    ${c.fix}`);
  }
  const warnings = checks.filter(c => c.status === 'warn').length;
  const errors = checks.filter(c => c.status === 'error').length;
  lines.push('');
  if (warnings === 0 && errors === 0) {
    lines.push('No problems found.');
  } else {
    lines.push(`${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} found.`);
  }
  return lines.join('\n');
}
