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
import { isDeepStrictEqual } from 'util';

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

// Claude Desktop passes the key by env-var reference, never inline. No space
// after the colon: Claude Desktop mis-splits args containing spaces.
const DESKTOP_HEADER_ARG = 'NANSEN-API-KEY:${NANSEN_API_KEY}';

// House idiom (see src/api.js CONFIG_DIR): env first so tests can point HOME
// at a temp dir; os.homedir() as last resort.
const houseHomedir = () => process.env.HOME || process.env.USERPROFILE || os.homedir();

export const SUPPORTED_CLIENTS = ['claude-code', 'claude-desktop', 'cursor'];

const MCP_USAGE = `nansen mcp — Install the Nansen MCP server into a local MCP client

USAGE:
  nansen mcp install <client>     Add the Nansen MCP server to the client's config
  nansen mcp uninstall <client>   Remove the Nansen MCP server from the client's config
  nansen mcp verify [client]      Verify setup with one authenticated data call

CLIENTS:
  claude-code      ~/.claude.json (user scope)
  claude-desktop   Claude Desktop config (macOS/Windows only)
  cursor           ~/.cursor/mcp.json

OPTIONS:
  --dry-run        Preview the change (key redacted) without writing

The API key is taken from \`nansen login\` / NANSEN_API_KEY. Re-run install after
rotating your key to update the entry. Verify performs one real authenticated data
call and consumes a small number of API credits. Other clients: https://docs.nansen.ai/mcp/connecting`;

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
      // No --allow-http: the URL is HTTPS.
      return {
        command: 'npx',
        args: ['-y', MCP_REMOTE_PIN, NANSEN_MCP_URL, '--header', DESKTOP_HEADER_ARG],
        env: { NANSEN_API_KEY: apiKey },
      };
    default:
      throw new CommandError(`Unknown client: ${client}. Supported: ${SUPPORTED_CLIENTS.join(', ')}`, 'INVALID_PARAMS');
  }
}

/**
 * A trailing slash is the same endpoint; anything else is a different server.
 */
const isOfficialUrl = (value) =>
  typeof value === 'string' && value.replace(/\/+$/, '') === NANSEN_MCP_URL;

/**
 * Extract the installed key, gating only on what decides where that key goes:
 * the official URL (for Claude Desktop, the pinned mcp-remote bridge to it)
 * plus a non-empty key. Anything looser would let verify report success for a
 * config that actually ships the key elsewhere.
 *
 * Deliberately not a deep-equal against buildServerEntry(): hand-written and
 * deep-link configs carry extra or reordered fields and are still valid, and
 * verify sends the key to the NANSEN_MCP_URL constant, never to the config's
 * URL. Non-security differences are reported by entryDriftNotes() as warnings.
 */
export function extractInstalledKey(client, entry) {
  if (!SUPPORTED_CLIENTS.includes(client)) return null;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;

  if (client === 'claude-desktop') {
    // The URL, the pin and the header all live in argv here, so argv is what has
    // to hold up: npx must run the pinned bridge itself — an npm execution
    // override (`--package=x`, `-p x`, `--call`) keeps every token below while
    // handing the key's process to something else — aimed at the official URL
    // and no other, and passing the key by env reference rather than inline (an
    // inline literal is a different key from the one verify would test).
    const args = Array.isArray(entry.args) ? entry.args : [];
    if (!args.every(arg => typeof arg === 'string')) return null;
    const pinIndex = args.indexOf(MCP_REMOTE_PIN);
    const headerIndex = args.indexOf(DESKTOP_HEADER_ARG);
    const officialBridge = entry.command === 'npx'
      && pinIndex !== -1
      && args.slice(0, pinIndex).every(arg => arg === '-y' || arg === '--yes')
      && args.some(isOfficialUrl)
      && !args.some(arg => /^https?:\/\//i.test(arg) && !isOfficialUrl(arg))
      && headerIndex > pinIndex
      && args[headerIndex - 1] === '--header'
      // mcp-remote applies every --header and the last assignment wins, so a
      // second key header would make the client send a key we never tested.
      && args.filter(arg => /^nansen-api-key\s*:/i.test(arg)).length === 1;
    if (!officialBridge) return null;
    // npx reads npm_config_*, NODE_OPTIONS and PATH from env, so any extra
    // variable can redirect which code receives the key: only the key may be set.
    const env = entry.env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
    if (Object.keys(env).some(name => name !== 'NANSEN_API_KEY')) return null;
    return typeof env.NANSEN_API_KEY === 'string' && env.NANSEN_API_KEY.length > 0 ? env.NANSEN_API_KEY : null;
  }

  // Remote HTTP clients: the URL is the transport. A command/args pair means the
  // client spawns a process instead and hands the key to that.
  if (!isOfficialUrl(entry.url)) return null;
  if (entry.command !== undefined || entry.args !== undefined) return null;
  const headers = entry.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;
  // Header names are case-insensitive on the wire, so two spellings mean the
  // client may send a key other than the one being verified.
  const keyHeaders = Object.keys(headers).filter(name => name.toLowerCase() === 'nansen-api-key');
  if (keyHeaders.length !== 1) return null;
  const apiKey = headers[keyHeaders[0]];
  return typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : null;
}

/**
 * Which fields differ from what install writes — missing, changed or extra.
 * Warned about rather than refused: none of them can send the key somewhere
 * else (extractInstalledKey already refuses that), but a changed or missing
 * field (e.g. claude-code's `type`) can stop the client loading the server.
 *
 * Notes name fields, never values, so a note can never carry the key. The key
 * itself is compared by substituting the installed one into the expectation.
 */
export function entryDriftNotes(client, entry) {
  if (!SUPPORTED_CLIENTS.includes(client)) return [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
  const installedKey = client === 'claude-desktop'
    ? entry.env?.NANSEN_API_KEY
    : Object.entries(entry.headers || {}).find(([name]) => name.toLowerCase() === 'nansen-api-key')?.[1];
  const expected = buildServerEntry(client, typeof installedKey === 'string' ? installedKey : '');
  const notes = [];
  for (const [field, want] of Object.entries(expected)) {
    if (entry[field] === undefined) notes.push(`missing "${field}"`);
    else if (!isDeepStrictEqual(entry[field], want)) notes.push(`changed "${field}"`);
  }
  for (const field of Object.keys(entry)) {
    if (!(field in expected)) notes.push(`unexpected "${field}"`);
  }
  return notes;
}

/**
 * Parse either a normal JSON response or the JSON-RPC event from an SSE body.
 */
export function parseMcpResponse(bodyText, expectedId) {
  const text = String(bodyText || '').trim();
  if (!text) throw new Error('Empty MCP response');

  try {
    return JSON.parse(text);
  } catch {
    let last;
    for (const line of text.split(/\r\n|\r|\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const message = JSON.parse(payload);
        last = message;
        if (message?.id === expectedId) return message;
      } catch { /* Ignore non-JSON SSE data lines. */ }
    }
    if (last !== undefined) return last;
  }

  throw new Error('Unparseable MCP response');
}

function mcpMessageDetail(message) {
  if (typeof message?.error?.message === 'string') return message.error.message;
  if (typeof message?.error === 'string') return message.error;
  const content = message?.result?.content;
  if (Array.isArray(content)) {
    const text = content
      .map(item => typeof item?.text === 'string' ? item.text : JSON.stringify(item))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  return 'The MCP server returned an error.';
}

/**
 * Map a parsed JSON-RPC response to the user-facing verification outcome.
 */
export function classifyVerifyResult(message) {
  const detail = mcpMessageDetail(message);
  const normalized = detail.toLowerCase();

  if (message?.result?.isError) {
    if (normalized.includes('nansen-api-key header is required')) {
      return {
        ok: false,
        reason: 'missing-key',
        detail: 'The MCP server received no API key. Re-run nansen mcp install <client> or nansen login.',
      };
    }
    if (normalized.includes('invalid api key') || normalized.includes('status 401')) {
      return {
        ok: false,
        reason: 'invalid-key',
        detail: 'The API key was rejected. Check your key at https://app.nansen.ai/account?tab=api, then run nansen login and re-run nansen mcp install <client>.',
      };
    }
    if (normalized.includes('unknown tool')) {
      return {
        ok: false,
        reason: 'unknown-tool',
        detail: 'The MCP server tool set changed. Update nansen-cli (npm i -g nansen-cli) or check https://docs.nansen.ai/mcp/connecting.',
      };
    }
    return {
      ok: false,
      reason: 'server-error',
      detail: `${detail}\nCheck https://docs.nansen.ai/mcp/connecting or contact support.`,
    };
  }

  if (message?.error) {
    if (normalized.includes('unknown tool')) {
      return {
        ok: false,
        reason: 'unknown-tool',
        detail: 'The MCP server tool set changed. Update nansen-cli (npm i -g nansen-cli) or check https://docs.nansen.ai/mcp/connecting.',
      };
    }
    return {
      ok: false,
      reason: 'server-error',
      detail: `${detail}\nCheck https://docs.nansen.ai/mcp/connecting or contact support.`,
    };
  }

  if (Array.isArray(message?.result?.content) && message.result.content.length > 0 && !message.result.isError) {
    return {
      ok: true,
      reason: 'success',
      detail: '✓ Authenticated MCP data call succeeded\nA real authenticated data call was made (consumes a small number of API credits).',
    };
  }

  return {
    ok: false,
    reason: 'unexpected-response',
    detail: 'Unexpected response from the MCP server. Update nansen-cli (npm i -g nansen-cli) or contact support.',
  };
}

const VERIFY_REQUEST_ID = 1;
const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_TOKEN_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

function redactSecret(text, secret) {
  return typeof text === 'string' && typeof secret === 'string' && secret
    ? text.split(secret).join('[redacted]')
    : text;
}

function verifyConnectivityError() {
  return new CommandError(
    'Could not connect to the MCP server. Check your network/proxy; run: nansen doctor for the broader diagnostic.',
    'NETWORK_ERROR',
  );
}

function verifyHttpError(status, bodyText) {
  if (status === 401 || status === 403) {
    return new CommandError(
      `The MCP server rejected the API key (HTTP ${status}). Check your key at https://app.nansen.ai/account?tab=api, then run nansen login and re-run nansen mcp install <client>.`,
      'INVALID_API_KEY',
    );
  }
  if (status === 429) {
    return new CommandError(
      'The MCP server rate limited verification (HTTP 429). Wait and retry; check your plan limits.',
      'RATE_LIMITED',
    );
  }
  if (status >= 500) {
    return new CommandError(
      `The MCP server returned HTTP ${status}. Retry later; check https://docs.nansen.ai/mcp/connecting or contact support.`,
      'SERVER_ERROR',
    );
  }
  const snippet = String(bodyText || '').trim().slice(0, 500) || '(empty body)';
  return new CommandError(
    `Unexpected response from the MCP server (HTTP ${status}): ${snippet}. Update nansen-cli (npm i -g nansen-cli) or contact support.`,
    'MCP_VERIFY_FAILED',
  );
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
    fetchFn = globalThis.fetch,
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

  const requireClient = (client, subcommand = 'install') => {
    if (!client || !SUPPORTED_CLIENTS.includes(client)) {
      throw new CommandError(`Usage: nansen mcp ${subcommand} <client>. Supported: ${SUPPORTED_CLIENTS.join(', ')}`, 'INVALID_PARAMS');
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

      if (sub !== 'install' && sub !== 'uninstall' && sub !== 'verify') {
        throw new CommandError(`Unknown subcommand: ${sub}\n\n${MCP_USAGE}`, 'INVALID_PARAMS');
      }

      if (sub === 'verify') {
        if (flags['dry-run']) {
          throw new CommandError('verify performs one real authenticated data call; there is no dry run', 'INVALID_PARAMS');
        }

        let apiKey;
        if (client) {
          requireClient(client, 'verify');
          const configPath = resolveReal(resolveClientConfigPath(client, { platform, homedir: homedirFn(), env }));
          const { config } = readConfig(configPath);
          const entry = config?.mcpServers?.[SERVER_KEY];
          if (!entry) {
            throw new CommandError(`Nansen MCP is not installed for ${client} — run: nansen mcp install ${client}`, 'NOT_INSTALLED');
          }
          apiKey = extractInstalledKey(client, entry);
          if (!apiKey) {
            throw new CommandError(`Nansen MCP entry for ${client} does not match the official server URL/transport, or carries no API key — re-run install: nansen mcp install ${client}`, 'INVALID_CONFIG');
          }
          const notes = entryDriftNotes(client, entry);
          if (notes.length) {
            log(`Warning: the ${client} entry differs from what install writes (${notes.join('; ')}). Verifying its key anyway — re-run nansen mcp install ${client} if the client cannot connect.`);
          }
        } else {
          apiKey = apiInstance?.apiKey;
          if (!apiKey) {
            throw new CommandError('Not logged in. Run: nansen login', 'NOT_LOGGED_IN');
          }
        }

        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: VERIFY_REQUEST_ID,
          method: 'tools/call',
          params: {
            name: 'token_info',
            arguments: {
              request: { chain: 'ethereum', tokenAddress: VERIFY_TOKEN_ADDRESS },
            },
          },
        });

        let response;
        let responseText;
        try {
          response = await fetchFn(NANSEN_MCP_URL, {
            method: 'POST',
            headers: {
              'NANSEN-API-KEY': apiKey,
              'Content-Type': 'application/json',
              'Accept': 'application/json, text/event-stream',
            },
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
          });
          responseText = redactSecret(await response.text(), apiKey);
        } catch (error) {
          if (error?.name === 'TimeoutError') {
            throw new CommandError(
              'MCP verification timed out after 15 seconds. Check your network/proxy; run: nansen doctor for the broader diagnostic.',
              'TIMEOUT',
            );
          }
          throw verifyConnectivityError();
        }

        if (response.status >= 300 && response.status < 400) throw verifyConnectivityError();
        if (response.status < 200 || response.status >= 300) throw verifyHttpError(response.status, responseText);

        let message;
        try {
          message = parseMcpResponse(responseText, VERIFY_REQUEST_ID);
        } catch {
          throw new CommandError(
            'Unexpected response from the MCP server. Update nansen-cli (npm i -g nansen-cli) or contact support.',
            'MCP_VERIFY_FAILED',
          );
        }

        const outcome = classifyVerifyResult(message);
        if (!outcome.ok) {
          throw new CommandError(outcome.detail.replaceAll('<client>', client || '<client>'), 'MCP_VERIFY_FAILED');
        }
        log(outcome.detail);
        return undefined;
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
      log(`Verify your setup: nansen mcp verify ${client}`);
      return undefined;
    },
  };
}
