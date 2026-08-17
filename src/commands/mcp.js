/**
 * Nansen CLI - MCP install command
 * One-step install of the hosted Nansen MCP server into local MCP clients.
 *
 * Writes a `nansen` entry into the client's own config file (merge-only,
 * atomic, backed up). No network calls, no shelling out.
 */

import { CommandError } from '../api.js';
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
export const MCP_REMOTE_PIN = 'mcp-remote@0.1.38';

const SERVER_KEY = 'nansen';

// House idiom (see src/api.js CONFIG_DIR): env first so tests can point HOME
// at a temp dir; os.homedir() as last resort.
const houseHomedir = () => process.env.HOME || process.env.USERPROFILE || os.homedir();

export const SUPPORTED_CLIENTS = ['claude-code', 'claude-desktop', 'cursor'];

const MCP_USAGE = `nansen mcp — Install the Nansen MCP server into a local MCP client

USAGE:
  nansen mcp install <client>     Add the Nansen MCP server to the client's config
  nansen mcp uninstall <client>   Remove the Nansen MCP server from the client's config

CLIENTS:
  claude-code      ~/.claude.json (user scope)
  claude-desktop   Claude Desktop config (macOS/Windows only)
  cursor           ~/.cursor/mcp.json

OPTIONS:
  --dry-run        Preview the change (key redacted) without writing

The API key is taken from \`nansen login\` / NANSEN_API_KEY. Re-run install after
rotating your key to update the entry. Other clients: https://docs.nansen.ai/mcp/connecting`;

/**
 * Resolve the client's config file path for this platform.
 * Throws CommandError for unsupported client/platform combos.
 */
export function resolveClientConfigPath(client, { platform = process.platform, homedir = houseHomedir(), env = process.env } = {}) {
  switch (client) {
    case 'claude-code':
      return path.join(homedir, '.claude.json');
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
      // No space after the colon: Claude Desktop mis-splits args containing spaces.
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
  } = deps;

  // Follow symlinks so dotfile-managed configs are edited in place instead of
  // having the link replaced by the atomic rename.
  const resolveReal = (p) => {
    try { return fsx.realpathSync(p); } catch { return p; }
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

  const requireClient = (client) => {
    if (!client || !SUPPORTED_CLIENTS.includes(client)) {
      throw new CommandError(`Usage: nansen mcp install <client>. Supported: ${SUPPORTED_CLIENTS.join(', ')}`, 'INVALID_PARAMS');
    }
  };

  return {
    'mcp': async (args, apiInstance, flags, _options) => {
      const sub = args[0];
      const client = args[1];

      if (!sub || flags.help || flags.h) {
        log(MCP_USAGE);
        return undefined;
      }

      if (sub !== 'install' && sub !== 'uninstall') {
        throw new CommandError(`Unknown subcommand: ${sub}\n\n${MCP_USAGE}`, 'INVALID_PARAMS');
      }

      requireClient(client);
      const configPath = resolveReal(resolveClientConfigPath(client, { platform, homedir: homedirFn(), env }));

      if (sub === 'uninstall') {
        const { config, existed } = readConfig(configPath);
        const { config: updated, removed } = removeNansenEntry(config, configPath);
        if (!existed || !removed) {
          log(`No Nansen MCP entry found in ${configPath}. Nothing to do.`);
          return undefined;
        }
        if (flags['dry-run']) {
          log(`Would remove "${SERVER_KEY}" entry from ${configPath} (no changes made).`);
          return undefined;
        }
        writeConfig(configPath, updated);
        log(`Removed Nansen MCP server from ${configPath}`);
        log(`Restart ${client} to pick up the change.`);
        return undefined;
      }

      // install
      const apiKey = apiInstance?.apiKey;
      if (!apiKey) {
        throw new CommandError('Not logged in. Run: nansen login', 'NOT_LOGGED_IN');
      }

      if (flags['dry-run']) {
        // The key is never printed — dry-run shows a redacted entry.
        const redacted = buildServerEntry(client, '<redacted>');
        log(`Would write "${SERVER_KEY}" entry to ${configPath}:`);
        log(JSON.stringify({ mcpServers: { [SERVER_KEY]: redacted } }, null, 2));
        return undefined;
      }

      const { config, existed } = readConfig(configPath);
      const hadEntry = !!config.mcpServers?.[SERVER_KEY];
      const merged = mergeNansenEntry(config, buildServerEntry(client, apiKey), configPath);

      if (existed) {
        const backupPath = `${configPath}.bak`;
        fsx.copyFileSync(configPath, backupPath);
        try { fsx.chmodSync(backupPath, 0o600); } catch { /* best-effort */ }
        log(`Backed up existing config to ${backupPath}`);
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
