/**
 * Nansen CLI - MCP install command
 * One-step install of the hosted Nansen MCP server into local MCP clients.
 *
 * Writes a `nansen` entry into the client's own config file (merge-only,
 * atomic, backed up). No network calls, no shelling out.
 */

import { CommandError } from '../api.js';
import { DEFAULT_MCP_URL, formatMcpVerifyReport, runMcpVerifyChecks } from '../mcp-verify.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Hosted Nansen MCP server (streamable HTTP, auth via NANSEN-API-KEY header).
// Deliberately a constant: a user-supplied URL would let `install` write the
// API key into a config that sends it to an arbitrary host. NANSEN_BASE_URL
// (REST dev override) intentionally does not affect this.
export const NANSEN_MCP_URL = 'https://mcp.nansen.ai/ra/mcp';

// Claude Desktop's config only supports stdio servers, so it bridges through
// mcp-remote. Pinned exact so `npx -y` never auto-pulls a compromised future
// release; bump deliberately.
export const MCP_REMOTE_PIN = 'mcp-remote@0.2.1';

const SERVER_KEY = 'nansen';

// House idiom (see src/api.js CONFIG_DIR): env first so tests can point HOME
// at a temp dir; os.homedir() as last resort.
const houseHomedir = () => process.env.HOME || process.env.USERPROFILE || os.homedir();

export const SUPPORTED_CLIENTS = ['claude-code', 'claude-desktop', 'cursor'];

const MCP_USAGE = `nansen mcp — Install the Nansen MCP server into a local MCP client

USAGE:
  nansen mcp install <client>     Add the Nansen MCP server to the client's config
  nansen mcp uninstall <client>   Remove the Nansen MCP server from the client's config
  nansen mcp verify [--api-key <key>] [--url <url>] [--send-api-key] [--json]
                                  Verify the hosted MCP server and API key

CLIENTS:
  claude-code      ~/.claude.json (user scope)
  claude-desktop   Claude Desktop config (macOS/Windows only)
  cursor           ~/.cursor/mcp.json

OPTIONS:
  --dry-run        Preview the change (key redacted) without writing
  --send-api-key   Authorize sending your saved API key to a custom --url
                   (an https:// or loopback host). Not needed for --api-key.

The API key is taken from \`nansen login\` / NANSEN_API_KEY. Re-run install after
rotating your key to update the entry. Other clients: https://docs.nansen.ai/mcp/connecting`;

/**
 * Resolve the client's config file path for this platform.
 * Throws CommandError for unsupported client/platform combos.
 */
export function resolveClientConfigPath(client, { platform = process.platform, homedir = houseHomedir(), env = process.env } = {}) {
  switch (client) {
    case 'claude-code':
      return path.join(env.CLAUDE_CONFIG_DIR || homedir, '.claude.json');
    case 'cursor':
      return path.join(homedir, '.cursor', 'mcp.json');
    case 'claude-desktop':
      if (platform === 'darwin') {
        return path.join(homedir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      }
      if (platform === 'win32') {
        return path.join(env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
      }
      throw new CommandError('Claude Desktop is not available on Linux. Use: nansen mcp install claude-code', 'UNSUPPORTED_PLATFORM');
    default:
      throw new CommandError(`Unknown client: ${client}. Supported: ${SUPPORTED_CLIENTS.join(', ')}`, 'INVALID_PARAMS');
  }
}

/**
 * Build the mcpServers entry for a client.
 * claude-code/cursor use native remote HTTP; claude-desktop bridges via mcp-remote.
 */
export function buildServerEntry(client, apiKey) {
  switch (client) {
    case 'claude-code':
      // "type" is required — a url without type is treated as broken stdio and skipped
      return { type: 'http', url: NANSEN_MCP_URL, headers: { 'NANSEN-API-KEY': apiKey } };
    case 'cursor':
      return { url: NANSEN_MCP_URL, headers: { 'NANSEN-API-KEY': apiKey } };
    case 'claude-desktop':
      // Header name and value must be one arg. mcp-remote parses with
      // /^([A-Za-z0-9_-]+):\s*(.*)$/, so whitespace after the colon is trimmed;
      // what breaks it is an empty value.
      // The ${NANSEN_API_KEY} placeholder is NOT shell syntax: mcp-remote itself
      // substitutes ${VAR} in header values from its process env — see
      // mcp-remote@0.2.1 dist/chunk-KIPEEEAF.js:29573-29576
      // (`value.replace(/\$\{([^}]+)}/g, ...)`, logging "Replacing ${...} with
      // environment value in header"). Claude Desktop injects the `env` block
      // into the spawned npx process, mcp-remote expands the reference, and the
      // key never appears in argv (visible in process listings). Verified live:
      // the exact written config connects to prod with the substitution logged.
      // Do NOT "fix" this by inlining the key into args.
      // No --allow-http: the URL is HTTPS.
      return {
        command: 'npx',
        args: ['-y', MCP_REMOTE_PIN, NANSEN_MCP_URL, '--header', 'NANSEN-API-KEY:${NANSEN_API_KEY}'],
        env: { NANSEN_API_KEY: apiKey },
      };
    default:
      throw new CommandError(`Unknown client: ${client}. Supported: ${SUPPORTED_CLIENTS.join(', ')}`, 'INVALID_PARAMS');
  }
}

function assertMergeableServers(config, configPath) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new CommandError(`${configPath} must contain a JSON object. Fix or move the file, then re-run.`, 'INVALID_CONFIG');
  }
  if (config.mcpServers !== undefined && (typeof config.mcpServers !== 'object' || config.mcpServers === null || Array.isArray(config.mcpServers))) {
    throw new CommandError(`"mcpServers" in ${configPath} is not an object. Fix or move the file, then re-run.`, 'INVALID_CONFIG');
  }
}

/**
 * Return a new config object with only mcpServers.nansen set/updated.
 * Every other key and server entry is preserved.
 */
export function mergeNansenEntry(config, entry, configPath = 'config') {
  assertMergeableServers(config, configPath);
  return { ...config, mcpServers: { ...config.mcpServers, [SERVER_KEY]: entry } };
}

/**
 * Return { config, removed } with mcpServers.nansen deleted.
 */
export function removeNansenEntry(config, configPath = 'config') {
  assertMergeableServers(config, configPath);
  if (!config.mcpServers || !(SERVER_KEY in config.mcpServers)) {
    return { config, removed: false };
  }
  const { [SERVER_KEY]: _removed, ...rest } = config.mcpServers;
  return { config: { ...config, mcpServers: rest }, removed: true };
}

export function buildMcpCommands(deps = {}) {
  const {
    log = console.log,
    fsOverride: fsx = fs,
    platform = process.platform,
    homedirFn = houseHomedir,
    env = process.env,
    fetchFn = fetch,
    devConfigPath,
  } = deps;

  // Follow symlinks so dotfile-managed configs are edited in place instead of
  // having the link replaced by the atomic rename.
  const resolveReal = (targetPath) => {
    let ancestor = targetPath;
    const missing = [];
    while (!fsx.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return targetPath;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    try { return path.join(fsx.realpathSync(ancestor), ...missing); } catch { return targetPath; }
  };

  const readConfig = (configPath) => {
    if (!fsx.existsSync(configPath)) return { config: {}, existed: false };
    let raw;
    try {
      raw = fsx.readFileSync(configPath, 'utf8');
    } catch (err) {
      throw new CommandError(`Could not read ${configPath}: ${err.message}`, 'INVALID_CONFIG');
    }
    try {
      return { config: JSON.parse(raw), existed: true };
    } catch {
      throw new CommandError(`Could not parse ${configPath} as JSON. Fix or move the file, then re-run.`, 'INVALID_CONFIG');
    }
  };

  // Atomic: temp file in the same dir, then rename over the target.
  // A crash mid-write can't leave a truncated config. chmod after rename is
  // best-effort (no-op semantics on Windows) — the file now holds a secret.
  const writeConfig = (configPath, config) => {
    const dir = path.dirname(configPath);
    if (!fsx.existsSync(dir)) fsx.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(configPath)}.tmp-${process.pid}`);
    try {
      fsx.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
      fsx.renameSync(tmp, configPath);
    } catch (err) {
      try { fsx.unlinkSync(tmp); } catch { /* temp file may not exist */ }
      throw err;
    }
    try { fsx.chmodSync(configPath, 0o600); } catch { /* Windows / exotic fs */ }
  };

  const backupConfig = (configPath) => {
    const backupPath = `${configPath}.bak`;
    const overwritten = fsx.existsSync(backupPath);
    fsx.copyFileSync(configPath, backupPath);
    try { fsx.chmodSync(backupPath, 0o600); } catch { /* best-effort */ }
    log(overwritten
      ? `Overwrote existing backup at ${backupPath}`
      : `Backed up existing config to ${backupPath}`);
    return backupPath;
  };

  const requireClient = (operation, client) => {
    if (!client || !SUPPORTED_CLIENTS.includes(client)) {
      throw new CommandError(`Usage: nansen mcp ${operation} <client>. Supported: ${SUPPORTED_CLIENTS.join(', ')}`, 'INVALID_PARAMS');
    }
  };

  const verify = async (flags, options, extraArgs = []) => {
    // --send-api-key is a valueless flag: `--send-api-key false` parses the
    // `false` as a positional arg while the flag still reads as present, which
    // would authorize the very disclosure the caller meant to decline. Reject
    // any positional args so that footgun fails loudly instead of leaking.
    // Never echo the argument: a plausible misuse is `--send-api-key "$KEY"`,
    // which lands the real key in extraArgs[0]; interpolating it would leak the
    // credential to stdout (and to logs under --json).
    if (extraArgs.length > 0) {
      throw new CommandError(
        '`nansen mcp verify` takes no positional arguments — --send-api-key is a valueless flag, do not pass it a value. Usage: nansen mcp verify [--api-key <key>] [--url <url>] [--send-api-key] [--json]',
        'INVALID_PARAMS',
      );
    }
    // A valueless --api-key parses as a flag and would silently fall back to
    // the saved key - the exact false positive this command exists to catch.
    if (flags['api-key']) {
      throw new CommandError('--api-key requires a value. Usage: nansen mcp verify --api-key <key>', 'MISSING_PARAM');
    }
    // parseArgs JSON-parses option values, so `--api-key null` arrives as
    // null and a repeated flag as an array - both must fail, not fall back.
    if ('api-key' in options && typeof options['api-key'] !== 'string') {
      throw new CommandError('--api-key must be a single key string. Usage: nansen mcp verify --api-key <key>', 'INVALID_PARAMS');
    }
    // Same guards for --url: a valueless flag or a repeated/JSON-parsed value
    // must fail loudly, not flow an array into fetch or silently fall back.
    if (flags.url) {
      throw new CommandError('--url requires a value. Usage: nansen mcp verify --url <url>', 'MISSING_PARAM');
    }
    if ('url' in options && typeof options.url !== 'string') {
      throw new CommandError('--url must be a single URL string. Usage: nansen mcp verify --url <url>', 'INVALID_PARAMS');
    }

    const url = options.url || DEFAULT_MCP_URL;
    const checks = await runMcpVerifyChecks({
      apiKey: options['api-key'],
      url,
      env,
      fetchFn,
      devConfigPath,
      sendApiKey: Boolean(flags['send-api-key']),
    });
    const verified = checks.some(checkItem => checkItem.id === 'mcp-auth' && checkItem.status === 'ok');
    const result = {
      verified,
      url,
      checks,
      errors: checks.filter(checkItem => checkItem.status === 'error').length,
      warnings: checks.filter(checkItem => checkItem.status === 'warn').length,
    };

    if (verified) {
      if (flags.json) return result;
      log(formatMcpVerifyReport(checks, url, true));
      return undefined;
    }

    const reason = (checks.find(checkItem => checkItem.status === 'error')
      || checks.find(checkItem => checkItem.id === 'mcp-auth' && checkItem.status !== 'ok'))?.message
      || 'the paid data path did not complete';
    const message = `MCP setup verification failed - ${reason}`;
    if (flags.json) throw new CommandError(message, 'MCP_VERIFY_FAILED', result);
    log(formatMcpVerifyReport(checks, url, false));
    // The human report above is the complete failure output; mark the error
    // so runCLI exits non-zero without also emitting the JSON envelope.
    const reportedError = new CommandError(message, 'MCP_VERIFY_FAILED');
    reportedError.reported = true;
    throw reportedError;
  };

  return {
    'mcp': async (args, apiInstance, flags, options) => {
      const sub = args[0];
      const client = args[1];

      if (!sub || flags.help || flags.h) {
        log(MCP_USAGE);
        return undefined;
      }

      if (sub === 'verify') {
        return verify(flags, options, args.slice(1));
      }

      if (sub !== 'install' && sub !== 'uninstall') {
        throw new CommandError(`Unknown subcommand: ${sub}\n\n${MCP_USAGE}`, 'INVALID_PARAMS');
      }

      requireClient(sub, client);
      const configPath = resolveReal(resolveClientConfigPath(client, { platform, homedir: homedirFn(), env }));

      if (sub === 'uninstall') {
        // Single state object, assigned only when the read+remove pair
        // succeeds. The !state guard below treats any escape from the try as
        // "nothing to do", so a future early-return added to the catch cannot
        // leak partial state into the backup/write path. Deliberately no
        // initializer: no-useless-assignment proves every current path assigns
        // or exits, and undefined already reads as "nothing to do".
        let state;
        try {
          const { config, existed } = readConfig(configPath);
          const { config: updated, removed } = removeNansenEntry(config, configPath);
          state = { existed, updated, removed };
        } catch (err) {
          // --dry-run must not throw on an unparseable config: users reach for it
          // precisely when unsure of the file's state. A real uninstall still
          // fails before writing.
          if (flags['dry-run']) {
            log(`Cannot preview ${configPath}: ${err.message} No changes made.`);
            return undefined;
          }
          throw err;
        }
        if (!state || !state.existed || !state.removed) {
          log(`No Nansen MCP entry found in ${configPath}. Nothing to do.`);
          return undefined;
        }
        const { updated } = state;
        if (flags['dry-run']) {
          log(`Would remove "${SERVER_KEY}" entry from ${configPath} (no changes made).`);
          return undefined;
        }
        // Same backup contract as install: an accidental uninstall of the wrong
        // client is recoverable. Backup failures surface before the config write.
        const backupPath = backupConfig(configPath);
        writeConfig(configPath, updated);
        log(`Removed Nansen MCP server from ${configPath}`);
        // The backup still holds the entry we just removed, key included.
        log(`Note: ${backupPath} still contains your API key (mode 0600). Delete it once you've confirmed the change.`);
        log(`Restart ${client} to pick up the change.`);
        return undefined;
      }

      // install
      const apiKey = apiInstance?.apiKey;
      if (!apiKey) {
        throw new CommandError('Not logged in. Run: nansen login', 'NOT_LOGGED_IN');
      }

      // Deliberate asymmetry with uninstall --dry-run (which previews even an
      // unparseable config): for install, a corrupt existing config is a
      // blocking error even under --dry-run, because the eventual write would
      // refuse it too — previewing a merge into a file we cannot parse would
      // promise something install cannot deliver.
      const { config, existed } = readConfig(configPath);

      if (flags['dry-run']) {
        // The key is never printed — dry-run shows a redacted entry.
        const redacted = buildServerEntry(client, '<redacted>');
        mergeNansenEntry(config, redacted, configPath);
        log(`Would write "${SERVER_KEY}" entry to ${configPath}:`);
        log(JSON.stringify({ mcpServers: { [SERVER_KEY]: redacted } }, null, 2));
        return undefined;
      }

      const hadEntry = !!config.mcpServers?.[SERVER_KEY];
      const merged = mergeNansenEntry(config, buildServerEntry(client, apiKey), configPath);

      if (existed) {
        backupConfig(configPath);
      }
      writeConfig(configPath, merged);

      log(hadEntry
        ? `Updated existing Nansen MCP entry in ${configPath}`
        : `Installed Nansen MCP server to ${configPath}`);
      log(`Note: your Nansen API key is stored in plaintext in ${configPath}.`);
      log('If this file is synced or backed up (settings sync, dotfiles), your key travels with it.');
      log(`Restart ${client} to pick up the change.`);
      return undefined;
    },
  };
}
